# Contributing

Use Node.js 24 LTS (`>=24 <25`), pnpm 10.34.5 and Python 3.12. The
same supported runtime lines are enforced by package metadata and CI; do not
validate a change only on an EOL Node release.

1. Create or update an executable specification before changing deterministic behavior.
2. Add a migration instead of editing an applied migration.
3. Keep domain/application/adapters dependency direction passing.
4. Add focused unit, contract, integration, security or recovery coverage proportional to risk.
5. Run the commands in `AGENTS.md` and update contracts/reports.
6. Never commit `.env`, tokens, backups, raw licensed sources or temporary managed repositories.
7. A knowledge change must use the proposal/review flow; direct runtime writes to published Git are forbidden.

Commit messages should identify the behavior changed. Reports must distinguish executed behavior from contracts and deferred capability.
