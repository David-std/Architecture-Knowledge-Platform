param(
  [string]$OutputDirectory = "backups/latest",
  [string]$PostgresContainer = "",
  [string]$PostgresDatabase = "akp",
  [string]$MinioContainer = "",
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

function Invoke-ExternalChecked {
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

function Resolve-ComposeContainer {
  param([Parameter(Mandatory = $true)][string]$Service)
  $id = ((Invoke-ExternalChecked "resolve Compose service '$Service'" {
    docker compose ps -q $Service
  }) | Out-String).Trim()
  if ([string]::IsNullOrWhiteSpace($id)) {
    throw "Compose service '$Service' is not running. Start the disposable recovery services first."
  }
  return $id
}

$PostgresContainer = if ($PostgresContainer) { $PostgresContainer } else { Resolve-ComposeContainer "postgres" }
$MinioContainer = if ($MinioContainer) { $MinioContainer } else { Resolve-ComposeContainer "minio" }
if (-not $PostgresContainer -or -not $MinioContainer) {
  throw "PostgreSQL and MinIO Compose services must be running"
}
if ($PostgresDatabase -notmatch '^[A-Za-z_][A-Za-z0-9_]{0,62}$') {
  throw "PostgreSQL database name must be a simple identifier."
}
$target = Resolve-InputPath $OutputDirectory
if (Test-Path -LiteralPath $target) {
  $existing = Get-ChildItem -LiteralPath $target -Force | Select-Object -First 1
  if ($null -ne $existing) {
    throw "Backup output directory must be new or empty: $target"
  }
} else {
  New-Item -ItemType Directory -Path $target | Out-Null
}
$configuredManagedRepository = if (-not [string]::IsNullOrWhiteSpace($ManagedRepository)) {
  $ManagedRepository
} elseif (-not [string]::IsNullOrWhiteSpace($env:AKP_MANAGED_REPO)) {
  $env:AKP_MANAGED_REPO
} else {
  $null
}
$managedRepositoryPresent = $false
$managedPath = $null
if ($configuredManagedRepository) {
  $managedPath = Resolve-InputPath $configuredManagedRepository
  if (-not (Test-Path -LiteralPath $managedPath -PathType Container)) {
    throw "AKP_MANAGED_REPO was configured but does not exist: $managedPath"
  }
  $isGit = ((Invoke-ExternalChecked "verify managed repository" {
    git -C $managedPath rev-parse --is-inside-work-tree
  }) | Out-String).Trim()
  if ($isGit -ne "true") {
    throw "AKP_MANAGED_REPO must be a Git work tree: $managedPath"
  }
  $managedRepositoryPresent = $true
}

$migrationRows = @(Invoke-ExternalChecked "read applied migration inventory" {
  docker exec $PostgresContainer psql -U akp -d $PostgresDatabase -At -F '|' -v ON_ERROR_STOP=1 -c "select name || '|' || coalesce(checksum,'') from schema_migrations order by name;"
})
$migrations = @(
  $migrationRows |
    ForEach-Object { $_.ToString().Trim() } |
    Where-Object { $_ } |
    ForEach-Object {
      $parts = $_ -split '\|', 2
      if ($parts.Count -ne 2 -or [string]::IsNullOrWhiteSpace($parts[0])) {
        throw "Applied migration inventory has an invalid row."
      }
      [ordered]@{ name = $parts[0]; checksum = $parts[1] }
    }
)
if ($migrations.Count -lt 1) {
  throw "The platform database contains no applied migrations; refusing to create a recovery artifact."
}
$artifactNames = @("postgres.dump", "minio-data.tar", "configuration-metadata.json")

docker exec $PostgresContainer pg_dump -U akp -d $PostgresDatabase -Fc -f /tmp/akp-backup.dump
if ($LASTEXITCODE -ne 0) { throw "pg_dump failed" }
docker cp "${PostgresContainer}:/tmp/akp-backup.dump" (Join-Path $target "postgres.dump")
if ($LASTEXITCODE -ne 0) { throw "docker cp for PostgreSQL backup failed" }
docker exec $PostgresContainer rm -f /tmp/akp-backup.dump

$minioData = Join-Path $target "minio-data.tar"
$inspectJson = @(docker inspect $MinioContainer 2>&1)
if ($LASTEXITCODE -ne 0) {
  $detail = ($inspectJson | Out-String).Trim()
  throw "Could not inspect MinIO container.$(if ($detail) { " Detail: $detail" })"
}
try {
  $inspect = $inspectJson | ConvertFrom-Json
  $minioVolume = @(
    $inspect[0].Mounts |
      Where-Object { $_.Destination -eq "/data" -and $_.Type -eq "volume" } |
      Select-Object -ExpandProperty Name
  ) | Select-Object -First 1
} catch {
  throw "Could not parse MinIO container mounts: $($_.Exception.Message)"
}
if ([string]::IsNullOrWhiteSpace($minioVolume)) {
  throw "Could not resolve MinIO data volume"
}
$helper = "akp-backup-$([guid]::NewGuid().ToString('N'))"
try {
  docker create --name $helper -v "${minioVolume}:/data:ro" busybox:1.37 sh -c "sleep 300" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Backup helper creation failed" }
  docker start $helper | Out-Null
  docker exec $helper tar -cf /tmp/akp-minio.tar -C /data .
  if ($LASTEXITCODE -ne 0) { throw "MinIO archive failed" }
  docker cp "${helper}:/tmp/akp-minio.tar" $minioData
  if ($LASTEXITCODE -ne 0) { throw "docker cp for MinIO backup failed" }
} finally {
  docker rm -f $helper 2>$null | Out-Null
}

if ($managedRepositoryPresent) {
  $bundlePath = Join-Path $target "managed-knowledge.bundle"
  Invoke-ExternalChecked "create managed knowledge Git bundle" {
    git -C $managedPath bundle create $bundlePath --all
  } | Out-Null
  Invoke-ExternalChecked "verify managed knowledge Git bundle" {
    git -C $managedPath bundle verify $bundlePath
  } | Out-Null
  $artifactNames += "managed-knowledge.bundle"
}

$configuration = [ordered]@{
  format = "akp-configuration-metadata-v2"
  managedRepositoryPresent = [bool]$managedRepositoryPresent
  vectorEnabled = ($env:AKP_VECTOR_ENABLED -eq "true")
  ingestRootsConfigured = -not [string]::IsNullOrWhiteSpace($env:AKP_INGEST_ROOTS)
  projectRootsConfigured = -not [string]::IsNullOrWhiteSpace($env:AKP_PROJECT_ROOTS)
  secretsIncluded = $false
}
$configuration | ConvertTo-Json -Depth 5 |
  Set-Content -LiteralPath (Join-Path $target "configuration-metadata.json") -Encoding utf8

$files = @(
  foreach ($name in $artifactNames) {
    $artifact = Join-Path $target $name
    if (-not (Test-Path -LiteralPath $artifact -PathType Leaf)) {
      throw "Expected backup artifact was not created: $name"
    }
    $item = Get-Item -LiteralPath $artifact
    [ordered]@{
      name = $name
      bytes = $item.Length
      sha256 = (Get-FileHash -LiteralPath $artifact -Algorithm SHA256).Hash.ToLowerInvariant()
    }
  }
)
$manifest = [ordered]@{
  format = "akp-backup-v3"
  createdAt = (Get-Date).ToUniversalTime().ToString("o")
  database = [ordered]@{
    migrationCount = $migrations.Count
    migrations = @($migrations)
  }
  managedRepository = [ordered]@{
    configured = [bool]$managedRepositoryPresent
    bundleIncluded = [bool]$managedRepositoryPresent
  }
  files = $files
}
$manifest | ConvertTo-Json -Depth 8 |
  Set-Content -LiteralPath (Join-Path $target "manifest.json") -Encoding utf8
Write-Output ($manifest | ConvertTo-Json -Depth 8)
