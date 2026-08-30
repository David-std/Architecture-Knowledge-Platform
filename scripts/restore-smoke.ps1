param(
  [string]$BackupDirectory = "backups/latest",
  [string]$PostgresContainer = "",
  [string]$ManagedRepository = ""
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

$PostgresContainer = if ($PostgresContainer) { $PostgresContainer } else { (docker compose ps -q postgres).Trim() }
if (-not $PostgresContainer) { throw "PostgreSQL Compose service must be running" }
$source = Resolve-InputPath $BackupDirectory
$manifestPath = Join-Path $source "manifest.json"
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
  throw "Backup manifest is missing. Create a new v3 backup before running recovery smoke."
}
try {
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
} catch {
  throw "Backup manifest is not valid JSON: $($_.Exception.Message)"
}
if ($manifest.format -ne "akp-backup-v3" -or $null -eq $manifest.database -or $null -eq $manifest.files) {
  throw "Backup manifest is too old or incomplete. Create a new v3 backup before running recovery smoke."
}
if ($null -eq $manifest.database.migrationCount -or [int]$manifest.database.migrationCount -lt 1) {
  throw "Backup manifest does not declare a valid database migration count. Create a new backup."
}
$expectedMigrations = @($manifest.database.migrations)
if ($expectedMigrations.Count -ne [int]$manifest.database.migrationCount) {
  throw "Backup manifest migration inventory does not match its declared count."
}

$artifactNames = @()
foreach ($entry in $manifest.files) {
  $name = [string]$entry.name
  if ([string]::IsNullOrWhiteSpace($name) -or $name -eq "manifest.json" -or [IO.Path]::GetFileName($name) -ne $name -or $name -match '[\\/]' -or [IO.Path]::IsPathRooted($name)) {
    throw "Backup manifest contains an unsafe artifact name."
  }
  $file = Join-Path $source $name
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Backup file missing: $name" }
  if ([string]$entry.sha256 -notmatch '^[a-fA-F0-9]{64}$') { throw "Backup manifest contains an invalid SHA-256 for $name" }
  if ($null -ne $entry.bytes -and [int64]$entry.bytes -ne [int64](Get-Item -LiteralPath $file).Length) { throw "Backup file size mismatch: $name" }
  $actual = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne ([string]$entry.sha256).ToLowerInvariant()) { throw "Hash mismatch: $name" }
  $artifactNames += $name
}
foreach ($required in @("postgres.dump", "minio-data.tar", "configuration-metadata.json")) {
  if ($artifactNames -notcontains $required) { throw "Backup manifest is missing required artifact: $required" }
}
$configuredManagedRepository = if (-not [string]::IsNullOrWhiteSpace($ManagedRepository)) {
  $ManagedRepository
} elseif (-not [string]::IsNullOrWhiteSpace($env:AKP_MANAGED_REPO)) {
  $env:AKP_MANAGED_REPO
} else {
  $null
}
$bundleRequired = [bool]$configuredManagedRepository -or [bool]$manifest.managedRepository.bundleIncluded
if ($bundleRequired -and $artifactNames -notcontains "managed-knowledge.bundle") {
  throw "Managed repository recovery is required but the verified bundle is absent."
}

$database = "akp_restore_smoke_$([guid]::NewGuid().ToString('N'))"
$dumpTemporaryPath = "/tmp/akp-restore-$([guid]::NewGuid().ToString('N')).dump"
$restoredDocuments = 0
$restoredMigrations = @()
try {
  docker exec $PostgresContainer psql -U akp -d postgres -v ON_ERROR_STOP=1 -c "create database `"$database`";"
  if ($LASTEXITCODE -ne 0) { throw "Could not create isolated restore database." }
  docker cp (Join-Path $source "postgres.dump") "${PostgresContainer}:$dumpTemporaryPath"
  if ($LASTEXITCODE -ne 0) { throw "Could not copy PostgreSQL recovery dump." }
  docker exec $PostgresContainer pg_restore -U akp -d $database --no-owner $dumpTemporaryPath
  if ($LASTEXITCODE -ne 0) { throw "PostgreSQL recovery restore failed." }
  $documentResult = docker exec $PostgresContainer psql -U akp -d $database -At -v ON_ERROR_STOP=1 -c "select count(*) from knowledge_documents;"
  if ($LASTEXITCODE -ne 0) { throw "Could not count restored knowledge documents." }
  $restoredDocuments = [int]$documentResult.Trim()
  $migrationRows = @(docker exec $PostgresContainer psql -U akp -d $database -At -F '|' -v ON_ERROR_STOP=1 -c "select name || '|' || coalesce(checksum,'') from schema_migrations order by name;")
  if ($LASTEXITCODE -ne 0) { throw "Could not read restored migration inventory." }
  $restoredMigrations = @(
    $migrationRows |
      ForEach-Object { $_.ToString().Trim() } |
      Where-Object { $_ } |
      ForEach-Object {
        $parts = $_ -split '\|', 2
        if ($parts.Count -ne 2) { throw "Restored migration inventory has an invalid row." }
        [ordered]@{ name = $parts[0]; checksum = $parts[1] }
      }
  )
} finally {
  & docker exec $PostgresContainer rm -f $dumpTemporaryPath *> $null
  & docker exec $PostgresContainer psql -U akp -d postgres -v ON_ERROR_STOP=1 -c "drop database if exists `"$database`";" *> $null
}
# An empty but migrated installation is a valid recovery target. The count
# query above still proves that the restored schema contains the canonical
# knowledge_documents table; populated-corpus checks belong to the runtime
# verification/evaluation gates, not to backup integrity.
if ($restoredMigrations.Count -ne [int]$manifest.database.migrationCount) {
  throw "Restored migration count ($($restoredMigrations.Count)) does not equal backup manifest count ($($manifest.database.migrationCount))."
}
for ($index = 0; $index -lt $expectedMigrations.Count; $index += 1) {
  $expected = $expectedMigrations[$index]
  $actual = $restoredMigrations[$index]
  if ($expected.name -ne $actual.name -or [string]$expected.checksum -ne [string]$actual.checksum) {
    throw "Restored migration inventory differs from the verified backup manifest at position $index."
  }
}

$restoreVolume = "akp-restore-smoke-$([guid]::NewGuid().ToString('N'))"
$restoreHelper = "akp-restore-helper-$([guid]::NewGuid().ToString('N'))"
$restoredObjectFiles = 0
try {
  docker volume create $restoreVolume | Out-Null
  docker create --name $restoreHelper -v "${restoreVolume}:/restore" busybox:1.37 sh -c "sleep 300" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Restore helper creation failed" }
  docker start $restoreHelper | Out-Null
  docker cp (Join-Path $source "minio-data.tar") "${restoreHelper}:/tmp/minio-data.tar"
  docker exec $restoreHelper tar -xf /tmp/minio-data.tar -C /restore
  if ($LASTEXITCODE -ne 0) { throw "MinIO restore extraction failed" }
  $restoredObjectFiles = [int](docker exec $restoreHelper sh -c "find /restore -type f | wc -l").Trim()
  if ($restoredObjectFiles -lt 1) { throw "Restored MinIO archive contains no files" }
} finally {
  docker rm -f $restoreHelper 2>$null | Out-Null
  docker volume rm $restoreVolume 2>$null | Out-Null
}

$gitBundle = Join-Path $source "managed-knowledge.bundle"
$gitRestoreVerified = $false
if ($artifactNames -contains "managed-knowledge.bundle") {
  $temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) "akp-git-restore-$([guid]::NewGuid())"
  try {
    git bundle verify $gitBundle
    if ($LASTEXITCODE -ne 0) { throw "Managed Git bundle verification failed" }
    git clone $gitBundle $temporaryRoot | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Managed Git bundle restore failed" }
    git -C $temporaryRoot fsck --full
    if ($LASTEXITCODE -ne 0) { throw "Managed Git bundle integrity check failed" }
    $gitRestoreVerified = $true
  } finally {
    $resolvedTemporary = [IO.Path]::GetFullPath($temporaryRoot)
    $safeTemporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if ($resolvedTemporary.StartsWith($safeTemporaryRoot, [StringComparison]::OrdinalIgnoreCase)) {
      Remove-Item -LiteralPath $resolvedTemporary -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}

Write-Output (@{
  status = "PASSED"
  restoredKnowledgeDocuments = $restoredDocuments
  restoredMigrations = $restoredMigrations.Count
  restoredMinioFiles = $restoredObjectFiles
  gitBundleVerified = $gitRestoreVerified
} | ConvertTo-Json)
