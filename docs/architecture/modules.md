# Module and dependency model

The platform is a modular monolith with adapters around deterministic cores.

```mermaid
flowchart BT
  Domain["@akp/domain"]
  Application["@akp/application"] --> Domain
  Compiler["@akp/compiler"] --> Domain
  Policy["@akp/policy"] --> Domain
  Retrieval["@akp/retrieval"] --> Contracts["@akp/contracts"]
  Graph["@akp/graph"] --> Domain
  API["apps/api"] --> Application
  API --> Retrieval
  Worker["apps/worker"] --> Compiler
  Worker --> GitStore["@akp/git-store"]
  Worker --> ObjectStore["@akp/object-store"]
  API --> Postgres["@akp/postgres"]
  Worker --> Postgres
  MCP["apps/mcp"] --> API
  CLI["apps/cli"] --> API
  Web["apps/web"] --> API
```

`dependency-cruiser.cjs` is the executable boundary gate. Shared packages contain technical primitives only. The Python extractor implements an external protocol and does not duplicate the domain model.

Primary modules map to identity, sources, ingestion, knowledge, review, retrieval, governance, evaluation and integration. They are currently deployed together; splitting them into microservices is not a goal.
