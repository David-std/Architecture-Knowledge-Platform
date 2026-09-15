param(
  [string]$BackupDirectory = "backups/ci-recovery",
  [string]$SourceManagedRepository = "",
  [string]$SpaceId = "00000000-0000-0000-0000-000000000003",
  [string]$PostgresContainer = "",
  [string]$PostgresDatabase = "akp"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Resolve-InputPath {
  param([Parameter(Mandatory = $true)][string]$Value)
  if ([IO.Path]::IsPathRooted($Value)) {
    return [IO.Path]::GetFullPath($Value)
  }
  return [IO.Path]::GetFullPath((Join-Path (Get-Location) $Value))
}

function Invoke-Checked {
  param(
    [Parameter(Mandatory = $true)][string]$Operation,
    [Parameter(Mandatory = $true)][scriptblock]$Command
  )
  $output = @(& $Command 2>&1)
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) {
    $detail = ($output | Out-String).Trim()
    throw "$Operation failed with exit code $exitCode.$(if ($detail) { " Detail: $detail" })"
  }
  return $output
}

$sourceRepository = if ($SourceManagedRepository) {
  Resolve-InputPath $SourceManagedRepository
} elseif ($env:AKP_MANAGED_REPO) {
  Resolve-InputPath $env:AKP_MANAGED_REPO
} else {
  throw "SourceManagedRepository or AKP_MANAGED_REPO is required."
}
$backup = Resolve-InputPath $BackupDirectory
$bundle = Join-Path $backup "managed-knowledge.bundle"
if (-not (Test-Path -LiteralPath $bundle -PathType Leaf)) {
  throw "Managed Git bundle is missing: $bundle"
}
$PostgresContainer = if ($PostgresContainer) {
  $PostgresContainer
} else {
  ((Invoke-Checked "resolve PostgreSQL Compose service" {
    docker compose ps -q postgres
  }) | Out-String).Trim()
}
if (-not $PostgresContainer) {
  throw "PostgreSQL Compose service must be running."
}

$expectedRevision = ((Invoke-Checked "read source managed main revision" {
  git -C $sourceRepository rev-parse refs/heads/main
}) | Out-String).Trim()
$expectedFiles = @(
  Invoke-Checked "read source managed file inventory" {
    git -C $sourceRepository ls-tree -r --name-only refs/heads/main
  } |
    ForEach-Object { $_.ToString().Trim() } |
    Where-Object { $_ } |
    Sort-Object
)
if ($expectedFiles.Count -lt 1) {
  throw "The managed restore proof requires at least one tracked file."
}

$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) "akp-managed-restore-$([guid]::NewGuid().ToString('N'))"
$reportRoot = Join-Path ([IO.Path]::GetTempPath()) "akp-managed-restore-report-$([guid]::NewGuid().ToString('N'))"
try {
  Invoke-Checked "verify managed Git bundle" {
    git bundle verify $bundle
  } | Out-Null
  Invoke-Checked "restore managed Git bundle into a new repository" {
    git clone $bundle $temporaryRoot
  } | Out-Null
  Invoke-Checked "fsck restored managed repository" {
    git -C $temporaryRoot fsck --full
  } | Out-Null

  $actualRevision = ((Invoke-Checked "read restored main revision" {
    git -C $temporaryRoot rev-parse refs/heads/main
  }) | Out-String).Trim()
  if ($actualRevision -ne $expectedRevision) {
    throw "Restored main revision mismatch. Expected $expectedRevision, got $actualRevision."
  }

  $actualFiles = @(
    Invoke-Checked "read restored file inventory" {
      git -C $temporaryRoot ls-tree -r --name-only refs/heads/main
    } |
      ForEach-Object { $_.ToString().Trim() } |
      Where-Object { $_ } |
      Sort-Object
  )
  $fileDifference = @(Compare-Object -ReferenceObject $expectedFiles -DifferenceObject $actualFiles)
  if ($fileDifference.Count -ne 0) {
    throw "Restored managed repository file inventory differs from the source repository."
  }
  foreach ($relativePath in $expectedFiles) {
    $restoredPath = Join-Path $temporaryRoot $relativePath
    if (-not (Test-Path -LiteralPath $restoredPath -PathType Leaf)) {
      throw "Expected restored managed file is missing from the checkout: $relativePath"
    }
  }

  New-Item -ItemType Directory -Path $reportRoot -Force | Out-Null
  $vaultKey = "recovery-restore-$([guid]::NewGuid().ToString('N'))"
  Invoke-Checked "rebuild searchable projections from restored managed repository" {
    pnpm akp vault import --vault-path $temporaryRoot --space-id $SpaceId --vault-key $vaultKey --read-only --report-dir $reportRoot
  } | Out-Null

  $safeVaultKey = $vaultKey.Replace("'", "''")
  $vaultId = ((Invoke-Checked "resolve rebuilt restored vault" {
    docker exec $PostgresContainer psql -U akp -d $PostgresDatabase -At -v ON_ERROR_STOP=1 -c "select id from vaults where vault_key='$safeVaultKey' and space_id='$SpaceId' limit 1;"
  }) | Out-String).Trim()
  if ($vaultId -notmatch '^[0-9a-fA-F-]{36}$') {
    throw "Could not resolve the rebuilt restored vault."
  }

  $importedDocuments = [int](((Invoke-Checked "verify rebuilt knowledge documents" {
    docker exec $PostgresContainer psql -U akp -d $PostgresDatabase -At -v ON_ERROR_STOP=1 -c "select count(*) from knowledge_documents where vault_id='$vaultId' and lifecycle='ACTIVE';"
  }) | Out-String).Trim())
  if ($importedDocuments -lt 1) {
    throw "Restored managed repository import produced no active knowledge documents."
  }

  $indexedUnits = [int](((Invoke-Checked "verify rebuilt knowledge units" {
    docker exec $PostgresContainer psql -U akp -d $PostgresDatabase -At -v ON_ERROR_STOP=1 -c "select count(*) from knowledge_units where vault_id='$vaultId' and lifecycle='ACTIVE';"
  }) | Out-String).Trim())
  if ($indexedUnits -lt 1) {
    throw "Restored managed repository produced no active searchable units."
  }

  $searchableUnits = [int](((Invoke-Checked "verify lexical search from rebuilt units" {
    docker exec $PostgresContainer psql -U akp -d $PostgresDatabase -At -v ON_ERROR_STOP=1 -c "select count(*) from knowledge_units where vault_id='$vaultId' and lifecycle='ACTIVE' and to_tsvector('simple',coalesce(body,'')) @@ plainto_tsquery('simple','restore probe');"
  }) | Out-String).Trim())
  if ($searchableUnits -lt 1) {
    throw "Restored managed repository could not rebuild a searchable probe."
  }

  Write-Output (@{
    status = "PASSED"
    expectedMainRevision = $expectedRevision
    restoredMainRevision = $actualRevision
    expectedFiles = $expectedFiles.Count
    restoredFiles = $actualFiles.Count
    importedDocuments = $importedDocuments
    indexedUnits = $indexedUnits
    searchableUnits = $searchableUnits
  } | ConvertTo-Json)
} finally {
  foreach ($candidate in @($temporaryRoot, $reportRoot)) {
    $resolved = [IO.Path]::GetFullPath($candidate)
    $safeTemporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if ($resolved.StartsWith($safeTemporaryRoot, [StringComparison]::OrdinalIgnoreCase)) {
      Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}
