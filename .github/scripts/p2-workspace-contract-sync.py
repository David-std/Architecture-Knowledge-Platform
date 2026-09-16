from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label} anchor changed: {count}")
    return text.replace(old, new, 1)


def replace_between(text: str, start: str, end: str, replacement: str, label: str) -> str:
    if text.count(start) != 1:
        raise SystemExit(f"{label} start anchor changed: {text.count(start)}")
    if text.count(end) != 1:
        raise SystemExit(f"{label} end anchor changed: {text.count(end)}")
    start_index = text.index(start)
    end_index = text.index(end, start_index)
    return text[:start_index] + replacement + text[end_index:]


# OpenAPI: publish the actual P2 coordination and principal HTTP surface.
openapi_path = Path("contracts/openapi.yaml")
openapi = openapi_path.read_text()
openapi = replace_once(
    openapi,
    """    it. POST /v1/auth/session is intentionally exempt because it creates a
    Set-Cookie response that cannot be safely replayed.
""",
    """    it. POST /v1/auth/session is intentionally exempt because it creates a
    Set-Cookie response that cannot be safely replayed. Agent-process credential
    issuance is also exempt because its raw token is returned exactly once and
    is never stored in replayable plaintext form.
""",
    "OpenAPI idempotency policy",
)

session_contract = """  /v1/sessions:
    get:
      tags: [Sessions]
      operationId: listAgentSessions
      x-akp-permission: knowledge:read
      x-akp-principal-action: workspace:read
      description: >
        List durable workspace sessions visible to the current participant. An
        AGENT_PROCESS principal only sees the session bound into its credential.
      responses:
        "200": { $ref: "#/components/responses/ObjectResponse" }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "403": { $ref: "#/components/responses/Forbidden" }
    post:
      tags: [Sessions]
      operationId: startAgentSession
      x-akp-permission: knowledge:read
      x-akp-principal-action: workspace:create
      parameters:
        - { $ref: "#/components/parameters/IdempotencyKey" }
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              additionalProperties: false
              required: [purpose, spaceId, vaultId]
              properties:
                purpose: { type: string, minLength: 1 }
                contextBudget:
                  { type: integer, minimum: 256, maximum: 32000, default: 6000 }
                projectId: { type: string, format: uuid }
                spaceId: { type: string, format: uuid }
                vaultId: { type: string, format: uuid }
      responses:
        "201": { $ref: "#/components/responses/ObjectResponse" }
        "400": { $ref: "#/components/responses/BadRequest" }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "403": { $ref: "#/components/responses/Forbidden" }
        "404": { $ref: "#/components/responses/NotFound" }
        "409": { $ref: "#/components/responses/Conflict" }

  /v1/sessions/{id}/state:
    get:
      tags: [Sessions]
      operationId: getAgentSessionState
      x-akp-permission: knowledge:read
      x-akp-principal-action: workspace:read
      parameters:
        - { $ref: "#/components/parameters/UuidId" }
      description: >
        Read the durable structured workspace snapshot for one authorized
        participant. The snapshot is sufficient for another participant to
        resume without relying on a prior chat transcript.
      responses:
        "200": { $ref: "#/components/responses/ObjectResponse" }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "403": { $ref: "#/components/responses/Forbidden" }
        "404": { $ref: "#/components/responses/NotFound" }

  /v1/sessions/{id}/participants:
    post:
      tags: [Sessions]
      operationId: addAgentSessionParticipant
      x-akp-permission: knowledge:read
      x-akp-principal-action: workspace:manage-participants
      parameters:
        - { $ref: "#/components/parameters/UuidId" }
        - { $ref: "#/components/parameters/IdempotencyKey" }
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              additionalProperties: false
              required: [userId]
              properties:
                userId: { type: string, format: uuid }
      responses:
        "200": { $ref: "#/components/responses/ObjectResponse" }
        "201": { $ref: "#/components/responses/ObjectResponse" }
        "400": { $ref: "#/components/responses/BadRequest" }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "403": { $ref: "#/components/responses/Forbidden" }
        "404": { $ref: "#/components/responses/NotFound" }
        "409": { $ref: "#/components/responses/Conflict" }
        "422":
          description: Target participant is not authorized for the full session vault.

  /v1/sessions/{id}/claims:
    post:
      tags: [Sessions]
      operationId: claimAgentSessionWork
      x-akp-permission: knowledge:read
      x-akp-principal-action: workspace:claim
      parameters:
        - { $ref: "#/components/parameters/UuidId" }
        - { $ref: "#/components/parameters/IdempotencyKey" }
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              additionalProperties: false
              required: [workKey]
              properties:
                workKey:
                  type: string
                  minLength: 1
                  maxLength: 200
                  description: Exact work key or terminal /** recursive scope.
                leaseSeconds:
                  { type: integer, minimum: 15, maximum: 900, default: 120 }
      responses:
        "201": { $ref: "#/components/responses/ObjectResponse" }
        "400": { $ref: "#/components/responses/BadRequest" }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "403": { $ref: "#/components/responses/Forbidden" }
        "404": { $ref: "#/components/responses/NotFound" }
        "409": { $ref: "#/components/responses/Conflict" }

  /v1/sessions/{id}/claims/heartbeat:
    post:
      tags: [Sessions]
      operationId: heartbeatAgentSessionClaim
      x-akp-permission: knowledge:read
      x-akp-principal-action: workspace:claim
      parameters:
        - { $ref: "#/components/parameters/UuidId" }
        - { $ref: "#/components/parameters/IdempotencyKey" }
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              additionalProperties: false
              required: [workKey, fencingToken]
              properties:
                workKey: { type: string, minLength: 1, maxLength: 200 }
                fencingToken: { type: integer, minimum: 1 }
                leaseSeconds:
                  { type: integer, minimum: 15, maximum: 900, default: 120 }
      responses:
        "200": { $ref: "#/components/responses/ObjectResponse" }
        "400": { $ref: "#/components/responses/BadRequest" }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "403": { $ref: "#/components/responses/Forbidden" }
        "404": { $ref: "#/components/responses/NotFound" }
        "409": { $ref: "#/components/responses/Conflict" }

  /v1/sessions/{id}/claims/handoff:
    post:
      tags: [Sessions]
      operationId: handoffAgentSessionClaim
      x-akp-permission: knowledge:read
      x-akp-principal-action: workspace:handoff
      parameters:
        - { $ref: "#/components/parameters/UuidId" }
        - { $ref: "#/components/parameters/IdempotencyKey" }
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              additionalProperties: false
              required: [workKey, toUserId, fencingToken]
              properties:
                workKey: { type: string, minLength: 1, maxLength: 200 }
                toUserId: { type: string, format: uuid }
                fencingToken: { type: integer, minimum: 1 }
                leaseSeconds:
                  { type: integer, minimum: 15, maximum: 900, default: 120 }
                note: { type: string, maxLength: 2048 }
      responses:
        "200": { $ref: "#/components/responses/ObjectResponse" }
        "400": { $ref: "#/components/responses/BadRequest" }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "403": { $ref: "#/components/responses/Forbidden" }
        "404": { $ref: "#/components/responses/NotFound" }
        "409": { $ref: "#/components/responses/Conflict" }
        "413":
          description: Handoff note exceeds the bounded payload size.
        "422":
          description: Handoff target is not authorized for the full session vault.

  /v1/sessions/{id}/events:
    post:
      tags: [Sessions]
      operationId: appendAgentSessionEvent
      x-akp-permission: knowledge:read
      x-akp-principal-action: workspace:event:append
      parameters:
        - { $ref: "#/components/parameters/UuidId" }
        - { $ref: "#/components/parameters/IdempotencyKey" }
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              additionalProperties: false
              required: [eventType]
              properties:
                eventType:
                  type: string
                  enum:
                    [FINDING, BLOCKER, QUESTION, ARTIFACT, DECISION_CANDIDATE, NOTE]
                payload:
                  type: object
                  additionalProperties: true
                  description: Bounded to 16 KiB after JSON serialization.
      responses:
        "201": { $ref: "#/components/responses/ObjectResponse" }
        "400": { $ref: "#/components/responses/BadRequest" }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "403": { $ref: "#/components/responses/Forbidden" }
        "404": { $ref: "#/components/responses/NotFound" }
        "409": { $ref: "#/components/responses/Conflict" }
        "413":
          description: Event payload is invalid or exceeds 16 KiB.

  /v1/sessions/{id}/agent-processes:
    post:
      tags: [Sessions, Authentication]
      operationId: issueAgentProcessCredential
      x-akp-permission: knowledge:read
      x-akp-principal-action: workspace:manage-agents
      x-akp-idempotency-exempt: true
      x-akp-secret-response: true
      parameters:
        - { $ref: "#/components/parameters/UuidId" }
      description: >
        OWNER-only human operation that creates a session- and vault-bound
        AGENT_PROCESS principal. The raw bearer token is returned exactly once;
        only its SHA-256 hash is persisted, so this operation is deliberately
        not replayed through the idempotency journal and is not exposed as an
        MCP tool.
      requestBody:
        content:
          application/json:
            schema:
              type: object
              additionalProperties: false
              properties:
                label: { type: string, minLength: 1, maxLength: 200 }
                durationMinutes:
                  { type: number, minimum: 5, maximum: 720, default: 60 }
                allowedActions:
                  type: array
                  minItems: 1
                  uniqueItems: true
                  items:
                    type: string
                    enum:
                      - workspace:read
                      - workspace:claim
                      - workspace:handoff
                      - workspace:event:append
                      - knowledge:read
                      - knowledge:propose
      responses:
        "201":
          description: Newly issued principal metadata plus one-time raw bearer token.
          content:
            application/json:
              schema:
                type: object
                required: [principal, token, authenticationKind]
                properties:
                  principal: { type: object, additionalProperties: true }
                  token: { type: string, minLength: 32 }
                  authenticationKind:
                    { type: string, const: PRINCIPAL_TOKEN }
        "400": { $ref: "#/components/responses/BadRequest" }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "403": { $ref: "#/components/responses/Forbidden" }
        "404": { $ref: "#/components/responses/NotFound" }

  /v1/agent-processes/{id}/revoke:
    post:
      tags: [Sessions, Authentication]
      operationId: revokeAgentProcessCredential
      x-akp-permission: knowledge:read
      x-akp-principal-action: workspace:manage-agents
      parameters:
        - { $ref: "#/components/parameters/UuidId" }
        - { $ref: "#/components/parameters/IdempotencyKey" }
      description: >
        Revoke an AGENT_PROCESS principal owned by the current human principal.
        Existing process credentials stop authenticating after revocation.
      responses:
        "200": { $ref: "#/components/responses/ObjectResponse" }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "403": { $ref: "#/components/responses/Forbidden" }
        "404": { $ref: "#/components/responses/NotFound" }
        "409": { $ref: "#/components/responses/Conflict" }

"""
openapi = replace_between(
    openapi,
    "  /v1/sessions:\n",
    "  /v1/context-packs/{id}:\n",
    session_contract,
    "OpenAPI sessions surface",
)
openapi_path.write_text(openapi)


# AsyncAPI: principal-aware audit identity plus the durable workspace blackboard.
asyncapi_path = Path("contracts/asyncapi.yaml")
asyncapi = asyncapi_path.read_text()
asyncapi = replace_once(
    asyncapi,
    """  auditEvents:
    address: internal.audit_events
    description: Rows persisted in the audit_events PostgreSQL table.
    messages:
      auditEvent:
        $ref: "#/components/messages/AuditEvent"
""",
    """  auditEvents:
    address: internal.audit_events
    description: Rows persisted in the audit_events PostgreSQL table.
    messages:
      auditEvent:
        $ref: "#/components/messages/AuditEvent"
  workspaceEvents:
    address: internal.workspace_events
    description: >
      Append-only coordination blackboard rows persisted in workspace_events.
      This is durable operational coordination state, not canonical knowledge
      and not an external message broker.
    messages:
      workspaceEvent:
        $ref: "#/components/messages/WorkspaceEvent"
""",
    "AsyncAPI workspace channel",
)
asyncapi = replace_once(
    asyncapi,
    """    AuditEvent:
      name: AuditEvent
      title: Persisted audit event
      payload:
        $ref: "#/components/schemas/AuditEventPayload"
""",
    """    AuditEvent:
      name: AuditEvent
      title: Persisted audit event
      payload:
        $ref: "#/components/schemas/AuditEventPayload"
    WorkspaceEvent:
      name: WorkspaceEvent
      title: Persisted workspace coordination event
      payload:
        $ref: "#/components/schemas/WorkspaceEventPayload"
""",
    "AsyncAPI workspace message",
)
asyncapi = replace_once(
    asyncapi,
    """        actorId:
          type: [string, "null"]
          format: uuid
        action: { type: string }
""",
    """        actorId:
          type: [string, "null"]
          format: uuid
        principalId:
          type: [string, "null"]
          format: uuid
          description: Distinct runtime principal identity when available.
        action: { type: string }
""",
    "AsyncAPI audit principal",
)
workspace_schema = """    WorkspaceEventPayload:
      type: object
      additionalProperties: false
      required:
        [id, sessionId, spaceId, vaultId, sessionVersion, eventType, payload, createdAt]
      properties:
        id: { type: integer, minimum: 1 }
        sessionId: { type: string, format: uuid }
        spaceId: { type: string, format: uuid }
        vaultId: { type: string, format: uuid }
        actorId:
          type: [string, "null"]
          format: uuid
          description: Compatibility user identity that authored the event.
        claimId:
          type: [string, "null"]
          format: uuid
        sessionVersion: { type: integer, minimum: 1 }
        eventType:
          type: string
          enum:
            - SESSION_CREATED
            - PARTICIPANT_JOINED
            - CLAIM_ACQUIRED
            - CLAIM_HEARTBEAT
            - CLAIM_HANDOFF
            - FINDING
            - BLOCKER
            - QUESTION
            - ARTIFACT
            - DECISION_CANDIDATE
            - NOTE
        payload:
          type: object
          additionalProperties: true
        createdAt: { type: string, format: date-time }
"""
asyncapi = replace_once(
    asyncapi,
    "    AuditEventPayload:\n",
    workspace_schema + "    AuditEventPayload:\n",
    "AsyncAPI workspace schema",
)
asyncapi_path.write_text(asyncapi)


# MCP: expose only the normal agent-safe coordination surface. Privileged
# one-time credential issuance intentionally remains HTTP/operator-only.
server_path = Path("apps/mcp/src/server.ts")
server = server_path.read_text()
workspace_tools = r'''  server.registerTool(
    "akp_list_sessions",
    {
      description:
        "List durable workspace sessions visible to the authenticated participant.",
      inputSchema: {},
    },
    async () => textResult(await api("/v1/sessions")),
  );

  server.registerTool(
    "akp_get_session_state",
    {
      description:
        "Read durable structured workspace state so an authorized participant can resume without prior chat history.",
      inputSchema: { sessionId: z.string().uuid() },
    },
    async ({ sessionId }) =>
      textResult(await api(`/v1/sessions/${encodeURIComponent(sessionId)}/state`)),
  );

  server.registerTool(
    "akp_claim_workspace_work",
    {
      description:
        "Acquire a bounded exact or recursive workspace claim with a lease and fencing token.",
      inputSchema: {
        sessionId: z.string().uuid(),
        workKey: z.string().min(1).max(200),
        leaseSeconds: z.number().int().min(15).max(900).default(120),
        idempotencyKey: z.string().min(8).max(200),
      },
    },
    async ({ sessionId, idempotencyKey, ...body }) =>
      textResult(
        await writeApi(
          `/v1/sessions/${encodeURIComponent(sessionId)}/claims`,
          idempotencyKey,
          body,
        ),
      ),
  );

  server.registerTool(
    "akp_heartbeat_workspace_claim",
    {
      description:
        "Renew an owned workspace claim only when its current fencing token matches.",
      inputSchema: {
        sessionId: z.string().uuid(),
        workKey: z.string().min(1).max(200),
        fencingToken: z.number().int().min(1),
        leaseSeconds: z.number().int().min(15).max(900).default(120),
        idempotencyKey: z.string().min(8).max(200),
      },
    },
    async ({ sessionId, idempotencyKey, ...body }) =>
      textResult(
        await writeApi(
          `/v1/sessions/${encodeURIComponent(sessionId)}/claims/heartbeat`,
          idempotencyKey,
          body,
        ),
      ),
  );

  server.registerTool(
    "akp_handoff_workspace_claim",
    {
      description:
        "Transfer an owned fenced workspace claim to another authorized participant with an optional structured note.",
      inputSchema: {
        sessionId: z.string().uuid(),
        workKey: z.string().min(1).max(200),
        toUserId: z.string().uuid(),
        fencingToken: z.number().int().min(1),
        leaseSeconds: z.number().int().min(15).max(900).default(120),
        note: z.string().max(2048).optional(),
        idempotencyKey: z.string().min(8).max(200),
      },
    },
    async ({ sessionId, idempotencyKey, ...body }) =>
      textResult(
        await writeApi(
          `/v1/sessions/${encodeURIComponent(sessionId)}/claims/handoff`,
          idempotencyKey,
          body,
        ),
      ),
  );

  server.registerTool(
    "akp_append_workspace_event",
    {
      description:
        "Append a bounded finding, blocker, question, artifact, decision candidate, or note to the durable workspace blackboard.",
      inputSchema: {
        sessionId: z.string().uuid(),
        eventType: z.enum([
          "FINDING",
          "BLOCKER",
          "QUESTION",
          "ARTIFACT",
          "DECISION_CANDIDATE",
          "NOTE",
        ]),
        payload: z.record(z.unknown()).default({}),
        idempotencyKey: z.string().min(8).max(200),
      },
    },
    async ({ sessionId, idempotencyKey, ...body }) =>
      textResult(
        await writeApi(
          `/v1/sessions/${encodeURIComponent(sessionId)}/events`,
          idempotencyKey,
          body,
        ),
      ),
  );

'''
server = replace_once(
    server,
    '  server.registerTool(\n    "akp_search",\n',
    workspace_tools + '  server.registerTool(\n    "akp_search",\n',
    "MCP workspace tool insertion",
)
server_path.write_text(server)


# Declarative MCP contract entries mirror the registered, agent-safe tools.
mcp_path = Path("contracts/mcp-tools.json")
mcp = mcp_path.read_text()
mcp_entries = r'''    {
      "name": "akp_list_sessions",
      "version": "1.0.0",
      "permission": "knowledge:read",
      "mutates": false,
      "inputSchema": {
        "type": "object",
        "additionalProperties": false,
        "properties": {}
      },
      "http": { "method": "GET", "path": "/v1/sessions" }
    },
    {
      "name": "akp_get_session_state",
      "version": "1.0.0",
      "permission": "knowledge:read",
      "mutates": false,
      "inputSchema": {
        "type": "object",
        "additionalProperties": false,
        "required": ["sessionId"],
        "properties": {
          "sessionId": { "type": "string", "format": "uuid" }
        }
      },
      "http": { "method": "GET", "path": "/v1/sessions/{id}/state" }
    },
    {
      "name": "akp_claim_workspace_work",
      "version": "1.0.0",
      "permission": "knowledge:read",
      "mutates": true,
      "requiresIdempotencyKey": true,
      "inputSchema": {
        "type": "object",
        "additionalProperties": false,
        "required": ["sessionId", "workKey", "idempotencyKey"],
        "properties": {
          "sessionId": { "type": "string", "format": "uuid" },
          "workKey": { "type": "string", "minLength": 1, "maxLength": 200 },
          "leaseSeconds": { "type": "integer", "minimum": 15, "maximum": 900, "default": 120 },
          "idempotencyKey": { "type": "string", "minLength": 8, "maxLength": 200 }
        }
      },
      "http": { "method": "POST", "path": "/v1/sessions/{id}/claims" }
    },
    {
      "name": "akp_heartbeat_workspace_claim",
      "version": "1.0.0",
      "permission": "knowledge:read",
      "mutates": true,
      "requiresIdempotencyKey": true,
      "inputSchema": {
        "type": "object",
        "additionalProperties": false,
        "required": ["sessionId", "workKey", "fencingToken", "idempotencyKey"],
        "properties": {
          "sessionId": { "type": "string", "format": "uuid" },
          "workKey": { "type": "string", "minLength": 1, "maxLength": 200 },
          "fencingToken": { "type": "integer", "minimum": 1 },
          "leaseSeconds": { "type": "integer", "minimum": 15, "maximum": 900, "default": 120 },
          "idempotencyKey": { "type": "string", "minLength": 8, "maxLength": 200 }
        }
      },
      "http": { "method": "POST", "path": "/v1/sessions/{id}/claims/heartbeat" }
    },
    {
      "name": "akp_handoff_workspace_claim",
      "version": "1.0.0",
      "permission": "knowledge:read",
      "mutates": true,
      "requiresIdempotencyKey": true,
      "inputSchema": {
        "type": "object",
        "additionalProperties": false,
        "required": ["sessionId", "workKey", "toUserId", "fencingToken", "idempotencyKey"],
        "properties": {
          "sessionId": { "type": "string", "format": "uuid" },
          "workKey": { "type": "string", "minLength": 1, "maxLength": 200 },
          "toUserId": { "type": "string", "format": "uuid" },
          "fencingToken": { "type": "integer", "minimum": 1 },
          "leaseSeconds": { "type": "integer", "minimum": 15, "maximum": 900, "default": 120 },
          "note": { "type": "string", "maxLength": 2048 },
          "idempotencyKey": { "type": "string", "minLength": 8, "maxLength": 200 }
        }
      },
      "http": { "method": "POST", "path": "/v1/sessions/{id}/claims/handoff" }
    },
    {
      "name": "akp_append_workspace_event",
      "version": "1.0.0",
      "permission": "knowledge:read",
      "mutates": true,
      "requiresIdempotencyKey": true,
      "inputSchema": {
        "type": "object",
        "additionalProperties": false,
        "required": ["sessionId", "eventType", "idempotencyKey"],
        "properties": {
          "sessionId": { "type": "string", "format": "uuid" },
          "eventType": {
            "type": "string",
            "enum": ["FINDING", "BLOCKER", "QUESTION", "ARTIFACT", "DECISION_CANDIDATE", "NOTE"]
          },
          "payload": { "type": "object", "additionalProperties": true },
          "idempotencyKey": { "type": "string", "minLength": 8, "maxLength": 200 }
        }
      },
      "http": { "method": "POST", "path": "/v1/sessions/{id}/events" }
    },
'''
mcp = replace_once(
    mcp,
    '    {\n      "name": "akp_search",\n',
    mcp_entries + '    {\n      "name": "akp_search",\n',
    "MCP contract workspace entries",
)
mcp_path.write_text(mcp)


# Contract validator: make the P2 shared-surface invariants executable without
# imposing unrelated historical parity changes on earlier MCP tools.
validator_path = Path("scripts/validate-contracts.mjs")
validator = validator_path.read_text()
p2_validation = r'''
const p2WorkspacePaths = {
  "/v1/sessions": { get: "workspace:read", post: "workspace:create" },
  "/v1/sessions/{id}/state": { get: "workspace:read" },
  "/v1/sessions/{id}/participants": {
    post: "workspace:manage-participants",
  },
  "/v1/sessions/{id}/claims": { post: "workspace:claim" },
  "/v1/sessions/{id}/claims/heartbeat": { post: "workspace:claim" },
  "/v1/sessions/{id}/claims/handoff": { post: "workspace:handoff" },
  "/v1/sessions/{id}/events": { post: "workspace:event:append" },
  "/v1/sessions/{id}/agent-processes": { post: "workspace:manage-agents" },
  "/v1/agent-processes/{id}/revoke": { post: "workspace:manage-agents" },
};
for (const [route, methods] of Object.entries(p2WorkspacePaths)) {
  for (const [method, principalAction] of Object.entries(methods)) {
    const operation = openapi?.paths?.[route]?.[method];
    if (!operation) {
      failures.push(`contracts/openapi.yaml: missing P2 ${method.toUpperCase()} ${route}`);
      continue;
    }
    if (operation["x-akp-permission"] !== "knowledge:read") {
      failures.push(`contracts/openapi.yaml: P2 ${method.toUpperCase()} ${route} must require knowledge:read`);
    }
    if (operation["x-akp-principal-action"] !== principalAction) {
      failures.push(`contracts/openapi.yaml: P2 ${method.toUpperCase()} ${route} must require principal action ${principalAction}`);
    }
  }
}

const sessionStartSchema =
  openapi?.paths?.["/v1/sessions"]?.post?.requestBody?.content?.[
    "application/json"
  ]?.schema ?? {};
const sessionStartRequired = requiredSet(sessionStartSchema);
for (const field of ["purpose", "spaceId", "vaultId"]) {
  if (!sessionStartRequired.has(field)) {
    failures.push(`contracts/openapi.yaml: session start missing required ${field}`);
  }
}

for (const route of [
  "/v1/sessions",
  "/v1/sessions/{id}/participants",
  "/v1/sessions/{id}/claims",
  "/v1/sessions/{id}/claims/heartbeat",
  "/v1/sessions/{id}/claims/handoff",
  "/v1/sessions/{id}/events",
  "/v1/agent-processes/{id}/revoke",
]) {
  if (!hasIdempotencyKey(openapi?.paths?.[route]?.post)) {
    failures.push(`contracts/openapi.yaml: P2 write ${route} must declare Idempotency-Key`);
  }
}
const agentIssue = openapi?.paths?.["/v1/sessions/{id}/agent-processes"]?.post;
if (
  agentIssue?.["x-akp-idempotency-exempt"] !== true ||
  agentIssue?.["x-akp-secret-response"] !== true
) {
  failures.push(
    "contracts/openapi.yaml: agent-process issuance must be marked one-time-secret and idempotency-exempt",
  );
}

if (!asyncapi?.channels?.workspaceEvents) {
  failures.push("contracts/asyncapi.yaml: missing durable workspaceEvents channel");
}
if (!asyncapi?.components?.schemas?.AuditEventPayload?.properties?.principalId) {
  failures.push("contracts/asyncapi.yaml: audit events must expose principalId");
}
const workspaceEvent = asyncapi?.components?.schemas?.WorkspaceEventPayload;
const workspaceEventRequired = requiredSet(workspaceEvent);
for (const field of [
  "sessionId",
  "spaceId",
  "vaultId",
  "sessionVersion",
  "eventType",
  "payload",
]) {
  if (!workspaceEventRequired.has(field)) {
    failures.push(`contracts/asyncapi.yaml: workspace event missing required ${field}`);
  }
}
'''
validator = replace_once(
    validator,
    'const dryRun = openapi?.paths?.["/v1/schema/dry-run"]?.post;\n',
    p2_validation + '\nconst dryRun = openapi?.paths?.["/v1/schema/dry-run"]?.post;\n',
    "P2 OpenAPI/AsyncAPI validation",
)
p2_mcp_validation = r'''
const requiredP2McpTools = [
  "akp_list_sessions",
  "akp_get_session_state",
  "akp_claim_workspace_work",
  "akp_heartbeat_workspace_claim",
  "akp_handoff_workspace_claim",
  "akp_append_workspace_event",
];
const declaredMcpNames = new Set((mcp.tools ?? []).map((tool) => tool.name));
for (const name of requiredP2McpTools) {
  if (!declaredMcpNames.has(name)) {
    failures.push(`contracts/mcp-tools.json: missing P2 tool ${name}`);
  }
}
if (
  (mcp.tools ?? []).some(
    (tool) => tool?.http?.path === "/v1/sessions/{id}/agent-processes",
  )
) {
  failures.push(
    "contracts/mcp-tools.json: one-time agent credential issuance must remain outside MCP",
  );
}
'''
validator = replace_once(
    validator,
    'console.log(\n  JSON.stringify({\n',
    p2_mcp_validation + '\nconsole.log(\n  JSON.stringify({\n',
    "P2 MCP validation",
)
validator_path.write_text(validator)


# Runtime MCP smoke must at least discover every P2 coordination tool. The live
# smoke continues to exercise retrieval; focused API integration owns mutation
# semantics and fencing behavior.
smoke_path = Path("scripts/mcp-smoke.ts")
smoke = smoke_path.read_text()
smoke = replace_once(
    smoke,
    '    "akp_start_session",\n    "akp_search",\n',
    '    "akp_start_session",\n    "akp_list_sessions",\n    "akp_get_session_state",\n    "akp_claim_workspace_work",\n    "akp_heartbeat_workspace_claim",\n    "akp_handoff_workspace_claim",\n    "akp_append_workspace_event",\n    "akp_search",\n',
    "MCP smoke P2 tools",
)
smoke_path.write_text(smoke)
