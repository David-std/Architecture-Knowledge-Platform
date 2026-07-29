$ErrorActionPreference = "Stop"

if (-not (Test-Path ".env")) {
    Copy-Item ".env.example" ".env"
}

docker compose up -d postgres minio
pnpm install
pnpm db:migrate
pnpm check

Write-Host "Starter validated. Configure AKP_VAULT_PATH before importing the vault."
