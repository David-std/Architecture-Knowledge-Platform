#!/usr/bin/env bash
set -euo pipefail

test -f .env || cp .env.example .env
docker compose up -d postgres minio
pnpm install
pnpm db:migrate
pnpm check

echo "Starter validated. Configure AKP_VAULT_PATH before importing the vault."
