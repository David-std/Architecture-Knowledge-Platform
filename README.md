# Architecture Knowledge Platform — Starter

This is an executable starter, not the completed product.

It establishes:

- modular boundaries;
- contracts;
- database schema;
- API/MCP surfaces;
- hybrid retrieval primitives;
- Python extractor boundary;
- CI and test structure.

Run after Codex completes dependencies and adapters:

```bash
cp .env.example .env
docker compose up -d postgres minio
pnpm install
pnpm db:migrate
pnpm test
pnpm dev
```

The existing vault is configured through `AKP_VAULT_PATH`.
