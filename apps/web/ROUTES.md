# Implemented web routes

```text
/                       workspace home (projects/work/reviews/agents/health)
/author                 browser recovery + governed Git draft + review submit
/search                 query and context packet inspector
/sources                source registry
/sources/:id            raw/derivative/evidence view
/ingest                 submit and track jobs
/jobs                   durable job status
/jobs/:id               job transition history
/reviews                review inbox
/reviews/:id            diff, sources, impact, validation and approval
/decisions              session-scoped architecture decision workspace
/decisions/:id          alternatives, consultation, objections, selection and promotion
/knowledge/:id          approved document view
/graph                   typed graph
/evals                   retrieval and grounding scorecards
/admin/spaces            space and RBAC
/admin/profiles          active/pending KnowledgeProfile governance
/admin/health            jobs, index parity and backups
/admin/audit             scoped audit-event viewer
/login                   token-to-HttpOnly-session exchange
```

Provider capability state is exposed through platform status and the extractor
`/v1/capabilities` endpoint. `/admin/providers` is not claimed as implemented.
