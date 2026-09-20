import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  GraphPathResult,
  GraphProjectionRevision,
  type GraphDerivation,
  type GraphDomain,
  type GraphNodeIdentity,
  type GraphProjectionArtifact,
  type GraphProjectionEdgeInput,
  type GraphProjectionNodeInput,
  type GraphProjectionPort,
  type GraphProvenanceEnvelope,
  type GraphQueryPort,
} from "@akp/contracts";
import { Postgres, PostgresFederatedGraphStore } from "../src/index.js";

const databaseUrl = process.env.DATABASE_URL;
const recordedAt = "2026-09-18T00:00:00.000Z";

interface Fixture {
  organizationId: string;
  spaceId: string;
  otherSpaceId: string;
  vaultA: string;
  vaultB: string;
  otherVault: string;
}

async function createFixture(db: Postgres): Promise<Fixture> {
  const fixture: Fixture = {
    organizationId: randomUUID(),
    spaceId: randomUUID(),
    otherSpaceId: randomUUID(),
    vaultA: randomUUID(),
    vaultB: randomUUID(),
    otherVault: randomUUID(),
  };
  await db.pool.query(
    `insert into organizations(id,slug,name)
     values($1,$2,'Federated graph integration')`,
    [
      fixture.organizationId,
      `federated-graph-${fixture.organizationId.slice(0, 8)}`,
    ],
  );
  await db.pool.query(
    `insert into spaces(
       id,organization_id,slug,name,visibility,knowledge_repo_path
     ) values
       ($1,$3,$4,'Federated graph primary','PRIVATE',$5),
       ($2,$3,$6,'Federated graph secondary','PRIVATE',$7)`,
    [
      fixture.spaceId,
      fixture.otherSpaceId,
      fixture.organizationId,
      `graph-primary-${fixture.spaceId.slice(0, 8)}`,
      `/tmp/graph-primary-${fixture.spaceId}`,
      `graph-secondary-${fixture.otherSpaceId.slice(0, 8)}`,
      `/tmp/graph-secondary-${fixture.otherSpaceId}`,
    ],
  );
  const vaultRows = [
    [fixture.vaultA, fixture.spaceId, "a"],
    [fixture.vaultB, fixture.spaceId, "b"],
    [fixture.otherVault, fixture.otherSpaceId, "other"],
  ] as const;
  for (const [vaultId, spaceId, suffix] of vaultRows) {
    await db.pool.query(
      `insert into vaults(
         id,space_id,canonical_path,name,read_only,current_revision,
         vault_key,local_path,visibility,enabled
       ) values($1,$2,$3,$4,true,'graph-source-r1',$5,$3,'PRIVATE',true)`,
      [
        vaultId,
        spaceId,
        `/tmp/federated-graph-${vaultId}`,
        `Federated graph vault ${suffix}`,
        `federated-graph-${suffix}-${vaultId.slice(0, 8)}`,
      ],
    );
  }
  return fixture;
}

async function cleanupFixture(db: Postgres, fixture: Fixture): Promise<void> {
  const spaces = [fixture.spaceId, fixture.otherSpaceId];
  await db.pool.query(
    "delete from event_outbox where space_id=any($1::uuid[])",
    [spaces],
  );
  await db.pool.query(
    "delete from federated_graph_projection_revisions where space_id=any($1::uuid[])",
    [spaces],
  );
  await db.pool.query(
    "delete from federated_graph_edges where space_id=any($1::uuid[])",
    [spaces],
  );
  await db.pool.query(
    "delete from federated_graph_relationship_assertions where space_id=any($1::uuid[])",
    [spaces],
  );
  await db.pool.query(
    "delete from federated_graph_nodes where space_id=any($1::uuid[])",
    [spaces],
  );
  await db.pool.query("delete from vaults where id=any($1::uuid[])", [
    [fixture.vaultA, fixture.vaultB, fixture.otherVault],
  ]);
  await db.pool.query("delete from spaces where id=any($1::uuid[])", [spaces]);
  await db.pool.query("delete from organizations where id=$1", [
    fixture.organizationId,
  ]);
}

function identity(
  graphDomain: GraphDomain,
  scopeId: string,
  kind: string,
  canonicalKey: string,
  revision: string,
): GraphNodeIdentity {
  return { graphDomain, scopeId, kind, canonicalKey, revision };
}

function node(
  identityValue: GraphNodeIdentity,
  vaultId: string | null,
  authorizationPath: string | null,
  payload: Record<string, unknown> = {},
): GraphProjectionNodeInput {
  return {
    identity: identityValue,
    vaultId,
    authorizationPath,
    payload,
  };
}

function provenance(
  derivation: GraphDerivation,
  revision: string,
  options: {
    validFrom?: string;
    validTo?: string;
    sourceIds?: string[];
    evidenceIds?: string[];
    locatorRefs?: string[];
  } = {},
): GraphProvenanceEnvelope {
  return {
    derivation,
    sourceIds: options.sourceIds ?? [`source:${revision}`],
    evidenceIds: options.evidenceIds ?? [],
    locatorRefs: options.locatorRefs ?? [],
    revision,
    ...(options.validFrom ? { validFrom: options.validFrom } : {}),
    ...(options.validTo ? { validTo: options.validTo } : {}),
    recordedAt,
  };
}

function edge(
  from: GraphNodeIdentity,
  relation: string,
  to: GraphNodeIdentity,
  derivation: GraphDerivation,
  revision: string,
  options: {
    authorizationPath?: string | null;
    validFrom?: string;
    validTo?: string;
  } = {},
): GraphProjectionEdgeInput {
  return {
    from,
    relation,
    to,
    ...(options.authorizationPath === undefined
      ? {}
      : { authorizationPath: options.authorizationPath }),
    provenance: provenance(derivation, revision, {
      ...(options.validFrom ? { validFrom: options.validFrom } : {}),
      ...(options.validTo ? { validTo: options.validTo } : {}),
    }),
  };
}

function artifact(input: {
  graphDomain: GraphDomain;
  spaceId: string;
  vaultId: string | null;
  scopeId: string;
  revision: string;
  nodes: readonly GraphProjectionNodeInput[];
  edges?: readonly GraphProjectionEdgeInput[];
}): GraphProjectionArtifact {
  return {
    graphDomain: input.graphDomain,
    spaceId: input.spaceId,
    vaultId: input.vaultId,
    scopeId: input.scopeId,
    revision: input.revision,
    sourceRevision: `source:${input.revision}`,
    sourceHash: null,
    provider: "integration-fixture",
    providerVersion: "1",
    configurationVersion: "graph-config-v1",
    nodes: input.nodes,
    edges: input.edges ?? [],
  };
}

function queryBase(
  fixture: Fixture,
  options: {
    vaults?: Array<{ vaultId: string; pathPrefix: string | null }>;
    domains?: GraphDomain[];
    relations?: string[];
    direction?: "outgoing" | "incoming" | "both";
    freshnessPolicy?: "FRESH_ONLY" | "ALLOW_STALE";
    maxHops?: number;
    maxFanout?: number;
    maxCandidates?: number;
    timeBudgetMs?: number;
  } = {},
) {
  return {
    authorization: {
      spaceId: fixture.spaceId,
      vaults: options.vaults ?? [{ vaultId: fixture.vaultA, pathPrefix: null }],
      allowSpaceScoped: false,
    },
    ...(options.domains ? { domains: options.domains } : {}),
    relationAllowlist: options.relations ?? [],
    direction: options.direction ?? ("outgoing" as const),
    freshnessPolicy: options.freshnessPolicy ?? ("FRESH_ONLY" as const),
    bounds: {
      maxHops: options.maxHops ?? 4,
      maxFanout: options.maxFanout ?? 50,
      maxCandidates: options.maxCandidates ?? 100,
      timeBudgetMs: options.timeBudgetMs ?? 5_000,
    },
  };
}

describe("federated multi-graph substrate integration", () => {
  it.skipIf(!databaseUrl)(
    "executes six graph domains through one revisioned query boundary without collapsing disagreement",
    async () => {
      if (!databaseUrl) return;
      const db = new Postgres(databaseUrl);
      const fixture = await createFixture(db);
      const store = new PostgresFederatedGraphStore(db);
      const queryPort: GraphQueryPort = store;
      const projectionPort: GraphProjectionPort<GraphProjectionArtifact> =
        store;
      try {
        const epistemicScope = "epistemic:primary";
        const codeScope = "code:primary";
        const runtimeScope = "runtime:primary";
        const temporalScope = "temporal:primary";
        const workScope = "work:primary";
        const catalogScope = "catalog:primary";

        const rule = identity(
          "EPISTEMIC",
          epistemicScope,
          "rule",
          "payments-api",
          "epistemic-r1",
        );
        const codeA = identity(
          "CODE",
          codeScope,
          "function",
          "payments-api",
          "code-r1",
        );
        const codeB = identity(
          "CODE",
          codeScope,
          "client",
          "ledger-client",
          "code-r1",
        );
        const runtimeNoCall = identity(
          "RUNTIME",
          runtimeScope,
          "observation",
          "payments-to-ledger:no-call",
          "runtime-r1",
        );
        const temporalFact = identity(
          "TEMPORAL",
          temporalScope,
          "fact",
          "deployment-window",
          "temporal-r1",
        );
        const workItem = identity(
          "WORK",
          workScope,
          "work-item",
          "WORK-42",
          "work-r1",
        );
        const serviceA = identity(
          "SOFTWARE_CATALOG",
          catalogScope,
          "service",
          "payments-api",
          "catalog-r1",
        );
        const serviceB = identity(
          "SOFTWARE_CATALOG",
          catalogScope,
          "service",
          "ledger-api",
          "catalog-r1",
        );

        for (const projection of [
          artifact({
            graphDomain: "EPISTEMIC",
            spaceId: fixture.spaceId,
            vaultId: fixture.vaultA,
            scopeId: epistemicScope,
            revision: "epistemic-r1",
            nodes: [
              node(rule, fixture.vaultA, "allowed/rule", {
                assertion: "Payments must use the governed ledger API.",
              }),
            ],
          }),
          artifact({
            graphDomain: "CODE",
            spaceId: fixture.spaceId,
            vaultId: fixture.vaultA,
            scopeId: codeScope,
            revision: "code-r1",
            nodes: [
              node(codeA, fixture.vaultA, "allowed/code/payments", {
                symbol: "createPayment",
              }),
              node(codeB, fixture.vaultA, "allowed/code/ledger", {
                symbol: "LedgerClient",
              }),
            ],
            edges: [
              edge(
                codeA,
                "imports_client",
                codeB,
                "STATICALLY_RESOLVED",
                "code-r1",
                { authorizationPath: "allowed/code/payments" },
              ),
            ],
          }),
          artifact({
            graphDomain: "RUNTIME",
            spaceId: fixture.spaceId,
            vaultId: fixture.vaultA,
            scopeId: runtimeScope,
            revision: "runtime-r1",
            nodes: [
              node(runtimeNoCall, fixture.vaultA, "allowed/runtime", {
                from: "payments-api",
                to: "ledger-api",
                observedCall: false,
                window: {
                  from: "2026-09-17T00:00:00.000Z",
                  to: "2026-09-18T00:00:00.000Z",
                },
              }),
            ],
          }),
          artifact({
            graphDomain: "TEMPORAL",
            spaceId: fixture.spaceId,
            vaultId: fixture.vaultA,
            scopeId: temporalScope,
            revision: "temporal-r1",
            nodes: [
              node(temporalFact, fixture.vaultA, "allowed/temporal", {
                fact: "payments-api deployed before the observed runtime window",
              }),
            ],
          }),
          artifact({
            graphDomain: "WORK",
            spaceId: fixture.spaceId,
            vaultId: fixture.vaultA,
            scopeId: workScope,
            revision: "work-r1",
            nodes: [
              node(workItem, fixture.vaultA, "allowed/work", {
                status: "IN_PROGRESS",
                summary: "Change ledger integration",
              }),
            ],
          }),
        ]) {
          expect(
            GraphProjectionRevision.safeParse(
              await projectionPort.build(projection),
            ).success,
          ).toBe(true);
        }

        const catalogProjection = artifact({
          graphDomain: "SOFTWARE_CATALOG",
          spaceId: fixture.spaceId,
          vaultId: fixture.vaultA,
          scopeId: catalogScope,
          revision: "catalog-r1",
          nodes: [
            node(serviceA, fixture.vaultA, "allowed/catalog/payments", {
              name: "Payments API",
            }),
            node(serviceB, fixture.vaultA, "allowed/catalog/ledger", {
              name: "Ledger API",
            }),
          ],
          edges: [
            edge(
              serviceA,
              "depends_on",
              serviceB,
              "SOURCE_EXPLICIT",
              "catalog-r1",
              { authorizationPath: "allowed/catalog/payments" },
            ),
            edge(
              serviceA,
              "implemented_by",
              codeA,
              "SOURCE_EXPLICIT",
              "catalog-r1",
              { authorizationPath: "allowed/catalog/payments" },
            ),
            edge(
              serviceA,
              "runtime_observation",
              runtimeNoCall,
              "RUNTIME_OBSERVED",
              "runtime-r1",
              {
                authorizationPath: "allowed/catalog/payments",
                validFrom: "2026-09-17T00:00:00.000Z",
                validTo: "2026-09-18T00:00:00.000Z",
              },
            ),
            edge(
              serviceA,
              "governed_by",
              rule,
              "HUMAN_ASSERTED",
              "epistemic-r1",
              { authorizationPath: "allowed/catalog/payments" },
            ),
            edge(
              serviceA,
              "changed_by",
              workItem,
              "SOURCE_EXPLICIT",
              "work-r1",
              { authorizationPath: "allowed/catalog/payments" },
            ),
            edge(
              serviceA,
              "contextualized_by",
              temporalFact,
              "SOURCE_EXPLICIT",
              "temporal-r1",
              { authorizationPath: "allowed/catalog/payments" },
            ),
          ],
        });
        const firstCatalogBuild = await projectionPort.build(catalogProjection);
        expect(
          GraphProjectionRevision.safeParse(firstCatalogBuild).success,
        ).toBe(true);
        const repeatedCatalogBuild =
          await projectionPort.build(catalogProjection);
        expect(repeatedCatalogBuild).toEqual(firstCatalogBuild);
        const lifecycleEvents = await db.pool.query<{
          event_id: string;
          event_type: string;
          causation_id: string | null;
          payload: Record<string, unknown>;
        }>(
          `select event_id::text,event_type,causation_id,payload
             from event_outbox
            where resource_id=$1
              and event_type=any($2::text[])
            order by created_at,event_id`,
          [
            firstCatalogBuild.id,
            ["GraphRevisionBuilt", "GraphRevisionActivated"],
          ],
        );
        expect(lifecycleEvents.rows).toHaveLength(2);
        const builtEvent = lifecycleEvents.rows.find(
          (event) => event.event_type === "GraphRevisionBuilt",
        );
        const activatedEvent = lifecycleEvents.rows.find(
          (event) => event.event_type === "GraphRevisionActivated",
        );
        expect(builtEvent?.payload).toMatchObject({
          projectionRevisionId: firstCatalogBuild.id,
          graphDomain: "SOFTWARE_CATALOG",
          scopeId: catalogScope,
          revision: "catalog-r1",
          sourceRevision: "source:catalog-r1",
          provider: "integration-fixture",
          configurationVersion: "graph-config-v1",
          lifecycle: "BUILT",
          freshness: "FRESH",
        });
        expect(activatedEvent?.causation_id).toBe(builtEvent?.event_id);
        expect(activatedEvent?.payload).toMatchObject({
          projectionRevisionId: firstCatalogBuild.id,
          graphDomain: "SOFTWARE_CATALOG",
          scopeId: catalogScope,
          revision: "catalog-r1",
          lifecycle: "ACTIVE",
          freshness: "FRESH",
          superseded: [],
        });
        const catalogRevisionState = await queryPort.revisionState(
          "SOFTWARE_CATALOG",
          fixture.spaceId,
          catalogScope,
        );
        expect(catalogRevisionState).toMatchObject({
          requestedRevision: "catalog-r1",
          builtRevision: "catalog-r1",
          activeRevision: "catalog-r1",
          activeFreshness: "FRESH",
          requested: {
            sourceRevision: "source:catalog-r1",
            sourceHash: null,
            provider: "integration-fixture",
            providerVersion: "1",
            configurationVersion: "graph-config-v1",
          },
          built: {
            revision: "catalog-r1",
            sourceRevision: "source:catalog-r1",
            provider: "integration-fixture",
          },
          active: {
            revision: "catalog-r1",
            freshness: "FRESH",
            sourceRevision: "source:catalog-r1",
            provider: "integration-fixture",
            configurationVersion: "graph-config-v1",
          },
        });

        const direct = await queryPort.neighbors({
          ...queryBase(fixture, {
            domains: [
              "EPISTEMIC",
              "SOFTWARE_CATALOG",
              "CODE",
              "RUNTIME",
              "TEMPORAL",
              "WORK",
            ],
            relations: [
              "depends_on",
              "implemented_by",
              "runtime_observation",
              "governed_by",
              "changed_by",
              "contextualized_by",
            ],
          }),
          seed: { identity: serviceA },
        });
        for (const result of direct) {
          expect(GraphPathResult.safeParse(result).success).toBe(true);
        }
        expect(
          [
            ...new Set(
              direct.map((result) => result.target.identity.graphDomain),
            ),
          ].sort(),
        ).toEqual(
          [
            "CODE",
            "EPISTEMIC",
            "RUNTIME",
            "SOFTWARE_CATALOG",
            "TEMPORAL",
            "WORK",
          ].sort(),
        );

        const codeBridge = direct.find(
          (result) => result.target.identity.graphDomain === "CODE",
        );
        expect(codeBridge?.seed.identity.canonicalKey).toBe("payments-api");
        expect(codeBridge?.target.identity.canonicalKey).toBe("payments-api");
        expect(codeBridge?.seed.id).not.toBe(codeBridge?.target.id);
        expect(codeBridge?.revisionSet).toMatchObject({
          SOFTWARE_CATALOG: "catalog-r1",
          CODE: "code-r1",
        });

        const allPaths = await queryPort.paths({
          ...queryBase(fixture, {
            domains: [
              "EPISTEMIC",
              "SOFTWARE_CATALOG",
              "CODE",
              "RUNTIME",
              "TEMPORAL",
              "WORK",
            ],
            relations: [
              "depends_on",
              "implemented_by",
              "imports_client",
              "runtime_observation",
              "governed_by",
              "changed_by",
              "contextualized_by",
            ],
            maxHops: 2,
          }),
          seed: { identity: serviceA },
        });

        const declared = allPaths.find(
          (result) =>
            result.target.identity.graphDomain === "SOFTWARE_CATALOG" &&
            result.target.identity.canonicalKey === "ledger-api",
        );
        const staticPath = allPaths.find(
          (result) =>
            result.target.identity.graphDomain === "CODE" &&
            result.target.identity.canonicalKey === "ledger-client",
        );
        const runtime = allPaths.find(
          (result) => result.target.identity.graphDomain === "RUNTIME",
        );
        expect(declared?.steps.map((step) => step.relation)).toEqual([
          "depends_on",
        ]);
        expect(staticPath?.steps.map((step) => step.relation)).toEqual([
          "implemented_by",
          "imports_client",
        ]);
        expect(runtime?.target.payload).toMatchObject({
          observedCall: false,
        });
        expect(runtime?.steps[0]?.provenance).toMatchObject({
          derivation: "RUNTIME_OBSERVED",
          revision: "runtime-r1",
          validFrom: "2026-09-17T00:00:00.000Z",
          validTo: "2026-09-18T00:00:00.000Z",
        });
        expect(declared).toBeDefined();
        expect(staticPath).toBeDefined();
        expect(runtime).toBeDefined();
      } finally {
        await cleanupFixture(db, fixture).catch(() => undefined);
        await db.close();
      }
    },
  );

  it.skipIf(!databaseUrl)(
    "keeps identities scoped across vaults, rejects cross-space bridges, and governs stale revision use",
    async () => {
      if (!databaseUrl) return;
      const db = new Postgres(databaseUrl);
      const fixture = await createFixture(db);
      const store = new PostgresFederatedGraphStore(db);
      try {
        const sharedA = identity(
          "CODE",
          `vault:${fixture.vaultA}`,
          "function",
          "shared-symbol",
          "vault-r1",
        );
        const sharedB = identity(
          "CODE",
          `vault:${fixture.vaultB}`,
          "function",
          "shared-symbol",
          "vault-r1",
        );
        await store.build(
          artifact({
            graphDomain: "CODE",
            spaceId: fixture.spaceId,
            vaultId: fixture.vaultA,
            scopeId: sharedA.scopeId,
            revision: "vault-r1",
            nodes: [node(sharedA, fixture.vaultA, "allowed/shared-a")],
          }),
        );
        await store.build(
          artifact({
            graphDomain: "CODE",
            spaceId: fixture.spaceId,
            vaultId: fixture.vaultB,
            scopeId: sharedB.scopeId,
            revision: "vault-r1",
            nodes: [node(sharedB, fixture.vaultB, "allowed/shared-b")],
          }),
        );

        const impactA = await store.impact({
          ...queryBase(fixture, {
            vaults: [
              { vaultId: fixture.vaultA, pathPrefix: null },
              { vaultId: fixture.vaultB, pathPrefix: null },
            ],
            domains: ["CODE"],
          }),
          seed: { identity: sharedA },
        });
        const impactB = await store.impact({
          ...queryBase(fixture, {
            vaults: [
              { vaultId: fixture.vaultA, pathPrefix: null },
              { vaultId: fixture.vaultB, pathPrefix: null },
            ],
            domains: ["CODE"],
          }),
          seed: { identity: sharedB },
        });
        expect(impactA.seed.id).not.toBe(impactB.seed.id);
        expect(impactA.seed.vaultId).toBe(fixture.vaultA);
        expect(impactB.seed.vaultId).toBe(fixture.vaultB);

        const collisionScope = "collision:shared-scope";
        const collisionIdentity = identity(
          "CODE",
          collisionScope,
          "function",
          "same-identity",
          "collision-r1",
        );
        await store.build(
          artifact({
            graphDomain: "CODE",
            spaceId: fixture.spaceId,
            vaultId: fixture.vaultA,
            scopeId: collisionScope,
            revision: "collision-r1",
            nodes: [
              node(collisionIdentity, fixture.vaultA, "allowed/collision-a"),
            ],
          }),
        );
        await expect(
          store.build(
            artifact({
              graphDomain: "CODE",
              spaceId: fixture.spaceId,
              vaultId: fixture.vaultB,
              scopeId: collisionScope,
              revision: "collision-r1",
              nodes: [
                node(collisionIdentity, fixture.vaultB, "allowed/collision-b"),
              ],
            }),
          ),
        ).rejects.toThrow("GRAPH_PROJECTION_REVISION_CONFLICT");

        const remoteTarget = identity(
          "TEMPORAL",
          "other-space:temporal",
          "fact",
          "remote-only",
          "remote-r1",
        );
        await store.build(
          artifact({
            graphDomain: "TEMPORAL",
            spaceId: fixture.otherSpaceId,
            vaultId: fixture.otherVault,
            scopeId: remoteTarget.scopeId,
            revision: "remote-r1",
            nodes: [
              node(remoteTarget, fixture.otherVault, "allowed/remote-only"),
            ],
          }),
        );
        const localSource = identity(
          "WORK",
          "cross-space-attempt",
          "work-item",
          "LOCAL-1",
          "cross-r1",
        );
        await expect(
          store.build(
            artifact({
              graphDomain: "WORK",
              spaceId: fixture.spaceId,
              vaultId: fixture.vaultA,
              scopeId: localSource.scopeId,
              revision: "cross-r1",
              nodes: [
                node(localSource, fixture.vaultA, "allowed/local-source"),
              ],
              edges: [
                edge(
                  localSource,
                  "references",
                  remoteTarget,
                  "SOURCE_EXPLICIT",
                  "cross-r1",
                ),
              ],
            }),
          ),
        ).rejects.toThrow("GRAPH_EDGE_NODE_NOT_FOUND");

        const staleScope = "code:stale-lifecycle";
        const staleV1 = identity(
          "CODE",
          staleScope,
          "function",
          "stale-seed",
          "stale-r1",
        );
        await store.build(
          artifact({
            graphDomain: "CODE",
            spaceId: fixture.spaceId,
            vaultId: fixture.vaultA,
            scopeId: staleScope,
            revision: "stale-r1",
            nodes: [node(staleV1, fixture.vaultA, "allowed/stale")],
          }),
        );
        const explicitlyStale = await store.markStale(
          "CODE",
          fixture.spaceId,
          staleScope,
          "new immutable repository commit observed",
        );
        expect(explicitlyStale).toMatchObject({
          revision: "stale-r1",
          lifecycle: "ACTIVE",
          freshness: "STALE",
        });
        await expect(
          store.impact({
            ...queryBase(fixture, {
              domains: ["CODE"],
              freshnessPolicy: "FRESH_ONLY",
            }),
            seed: { identity: staleV1 },
          }),
        ).rejects.toThrow("GRAPH_NODE_NOT_FOUND_OR_UNAUTHORIZED");
        const staleFallback = await store.impact({
          ...queryBase(fixture, {
            domains: ["CODE"],
            freshnessPolicy: "ALLOW_STALE",
          }),
          seed: { identity: staleV1 },
        });
        expect(staleFallback.seed.projection).toMatchObject({
          revision: "stale-r1",
          lifecycle: "ACTIVE",
          freshness: "STALE",
        });
        const staleEvents = await db.pool.query<{
          event_type: string;
          payload: Record<string, unknown>;
        }>(
          `select event_type,payload
             from event_outbox
            where resource_id=$1 and event_type='GraphRevisionStale'`,
          [explicitlyStale?.id],
        );
        expect(staleEvents.rows).toHaveLength(1);
        expect(staleEvents.rows[0]?.payload).toMatchObject({
          graphDomain: "CODE",
          scopeId: staleScope,
          revision: "stale-r1",
          freshness: "STALE",
        });

        const staleV2 = identity(
          "CODE",
          staleScope,
          "function",
          "stale-seed",
          "stale-r2",
        );
        const updated = await store.update({
          baseRevision: "stale-r1",
          next: artifact({
            graphDomain: "CODE",
            spaceId: fixture.spaceId,
            vaultId: fixture.vaultA,
            scopeId: staleScope,
            revision: "stale-r2",
            nodes: [node(staleV2, fixture.vaultA, "allowed/stale")],
          }),
        });
        expect(updated).toMatchObject({
          revision: "stale-r2",
          lifecycle: "ACTIVE",
          freshness: "FRESH",
        });
        await expect(
          store.update({
            baseRevision: "stale-r1",
            next: artifact({
              graphDomain: "CODE",
              spaceId: fixture.spaceId,
              vaultId: fixture.vaultA,
              scopeId: staleScope,
              revision: "stale-r3",
              nodes: [
                node(
                  identity(
                    "CODE",
                    staleScope,
                    "function",
                    "stale-seed",
                    "stale-r3",
                  ),
                  fixture.vaultA,
                  "allowed/stale",
                ),
              ],
            }),
          }),
        ).rejects.toThrow("GRAPH_PROJECTION_BASE_REVISION_CHANGED");

        const lifecycle = await db.pool.query<{
          revision: string;
          lifecycle: string;
          freshness: string;
        }>(
          `select revision,lifecycle,freshness
             from federated_graph_projection_revisions
            where space_id=$1 and graph_domain='CODE' and scope_id=$2
            order by revision`,
          [fixture.spaceId, staleScope],
        );
        expect(lifecycle.rows).toEqual([
          {
            revision: "stale-r1",
            lifecycle: "STALE",
            freshness: "STALE",
          },
          {
            revision: "stale-r2",
            lifecycle: "ACTIVE",
            freshness: "FRESH",
          },
        ]);

        await db.pool.query(
          `update federated_graph_projection_revisions
              set freshness='STALE'
            where space_id=$1 and graph_domain='CODE' and scope_id=$2
              and revision='stale-r2'`,
          [fixture.spaceId, staleScope],
        );
        await expect(
          store.impact({
            ...queryBase(fixture, {
              domains: ["CODE"],
              freshnessPolicy: "FRESH_ONLY",
            }),
            seed: { identity: staleV2 },
          }),
        ).rejects.toThrow("GRAPH_NODE_NOT_FOUND_OR_UNAUTHORIZED");
        const degraded = await store.impact({
          ...queryBase(fixture, {
            domains: ["CODE"],
            freshnessPolicy: "ALLOW_STALE",
          }),
          seed: { identity: staleV2 },
        });
        expect(degraded.seed.projection).toMatchObject({
          revision: "stale-r2",
          freshness: "STALE",
        });

        const fallbackScope = "code:failed-build-fallback";
        const fallbackR1 = identity(
          "CODE",
          fallbackScope,
          "function",
          "fallback-seed",
          "fallback-r1",
        );
        await store.build(
          artifact({
            graphDomain: "CODE",
            spaceId: fixture.spaceId,
            vaultId: fixture.vaultA,
            scopeId: fallbackScope,
            revision: "fallback-r1",
            nodes: [node(fallbackR1, fixture.vaultA, "allowed/fallback-seed")],
          }),
        );

        const fallbackR2 = identity(
          "CODE",
          fallbackScope,
          "function",
          "fallback-seed",
          "fallback-r2",
        );
        const missingR2Target = identity(
          "CODE",
          fallbackScope,
          "function",
          "missing-target",
          "fallback-r2",
        );
        await expect(
          store.update({
            baseRevision: "fallback-r1",
            next: artifact({
              graphDomain: "CODE",
              spaceId: fixture.spaceId,
              vaultId: fixture.vaultA,
              scopeId: fallbackScope,
              revision: "fallback-r2",
              nodes: [
                node(fallbackR2, fixture.vaultA, "allowed/fallback-seed"),
              ],
              edges: [
                edge(
                  fallbackR2,
                  "calls",
                  missingR2Target,
                  "STATICALLY_RESOLVED",
                  "fallback-r2",
                ),
              ],
            }),
          }),
        ).rejects.toThrow("GRAPH_EDGE_NODE_NOT_FOUND");

        const fallbackState = await store.revisionState(
          "CODE",
          fixture.spaceId,
          fallbackScope,
        );
        expect(fallbackState).toMatchObject({
          requestedRevision: "fallback-r2",
          builtRevision: "fallback-r1",
          activeRevision: "fallback-r1",
          activeFreshness: "FRESH",
          requested: {
            revision: "fallback-r2",
            lifecycle: "FAILED",
            freshness: "STALE",
          },
          active: {
            revision: "fallback-r1",
            lifecycle: "ACTIVE",
            freshness: "FRESH",
          },
        });
        const fallbackRead = await store.impact({
          ...queryBase(fixture, {
            domains: ["CODE"],
            freshnessPolicy: "FRESH_ONLY",
          }),
          seed: { identity: fallbackR1 },
        });
        expect(fallbackRead.seed.projection).toMatchObject({
          revision: "fallback-r1",
          lifecycle: "ACTIVE",
          freshness: "FRESH",
        });
      } finally {
        await cleanupFixture(db, fixture).catch(() => undefined);
        await db.close();
      }
    },
  );

  it.skipIf(!databaseUrl)(
    "filters unauthorized intermediate nodes and keeps traversal bounded, cyclic-safe, and deterministic",
    async () => {
      if (!databaseUrl) return;
      const db = new Postgres(databaseUrl);
      const fixture = await createFixture(db);
      const store = new PostgresFederatedGraphStore(db);
      try {
        const scopeId = "code:bounded";
        const revision = "bounded-r1";
        const seed = identity("CODE", scopeId, "function", "seed", revision);
        const hidden = identity(
          "CODE",
          scopeId,
          "function",
          "hidden",
          revision,
        );
        const target = identity(
          "CODE",
          scopeId,
          "function",
          "target",
          revision,
        );
        const tieA = identity("CODE", scopeId, "function", "tie-a", revision);
        const tieB = identity("CODE", scopeId, "function", "tie-b", revision);
        await store.build(
          artifact({
            graphDomain: "CODE",
            spaceId: fixture.spaceId,
            vaultId: fixture.vaultA,
            scopeId,
            revision,
            nodes: [
              node(seed, fixture.vaultA, "allowed/seed"),
              node(hidden, fixture.vaultA, "private/hidden"),
              node(target, fixture.vaultA, "allowed/target"),
              node(tieA, fixture.vaultA, "allowed/tie-a"),
              node(tieB, fixture.vaultA, "allowed/tie-b"),
            ],
            edges: [
              edge(seed, "calls", hidden, "STATICALLY_RESOLVED", revision, {
                authorizationPath: "allowed/seed",
              }),
              edge(hidden, "calls", target, "STATICALLY_RESOLVED", revision, {
                authorizationPath: "private/hidden",
              }),
              edge(target, "calls", seed, "STATICALLY_RESOLVED", revision, {
                authorizationPath: "allowed/target",
              }),
              edge(
                seed,
                "secret_bridge",
                target,
                "STATICALLY_RESOLVED",
                revision,
                {
                  authorizationPath: "private/bridge",
                },
              ),
              // Insert reverse lexical order to prove result order is not
              // inherited from write order.
              edge(seed, "related", tieB, "STATICALLY_RESOLVED", revision, {
                authorizationPath: "allowed/seed",
              }),
              edge(seed, "related", tieA, "STATICALLY_RESOLVED", revision, {
                authorizationPath: "allowed/seed",
              }),
            ],
          }),
        );

        const full = await store.paths({
          ...queryBase(fixture, {
            domains: ["CODE"],
            relations: ["calls"],
            maxHops: 5,
          }),
          seed: { identity: seed },
        });
        const targetPath = full.find(
          (result) => result.target.identity.canonicalKey === "target",
        );
        expect(
          targetPath?.steps.map((step) => step.to.identity.canonicalKey),
        ).toEqual(["hidden", "target"]);
        for (const path of full) {
          const ids = [path.seed.id, ...path.steps.map((step) => step.to.id)];
          expect(new Set(ids).size).toBe(ids.length);
          expect(path.steps.length).toBeLessThanOrEqual(5);
        }

        const restricted = await store.paths({
          ...queryBase(fixture, {
            vaults: [{ vaultId: fixture.vaultA, pathPrefix: "allowed" }],
            domains: ["CODE"],
            relations: ["calls"],
            maxHops: 5,
          }),
          seed: { identity: seed },
        });
        expect(
          restricted.some(
            (result) => result.target.identity.canonicalKey === "target",
          ),
        ).toBe(false);
        expect(
          restricted.some(
            (result) => result.target.identity.canonicalKey === "hidden",
          ),
        ).toBe(false);

        const fullPrivateBridge = await store.neighbors({
          ...queryBase(fixture, {
            domains: ["CODE"],
            relations: ["secret_bridge"],
          }),
          seed: { identity: seed },
        });
        expect(
          fullPrivateBridge.map(
            (result) => result.target.identity.canonicalKey,
          ),
        ).toEqual(["target"]);
        const restrictedPrivateBridge = await store.neighbors({
          ...queryBase(fixture, {
            vaults: [{ vaultId: fixture.vaultA, pathPrefix: "allowed" }],
            domains: ["CODE"],
            relations: ["secret_bridge"],
          }),
          seed: { identity: seed },
        });
        expect(restrictedPrivateBridge).toEqual([]);

        const tiesFirst = await store.neighbors({
          ...queryBase(fixture, {
            domains: ["CODE"],
            relations: ["related"],
          }),
          seed: { identity: seed },
        });
        const tiesSecond = await store.neighbors({
          ...queryBase(fixture, {
            domains: ["CODE"],
            relations: ["related"],
          }),
          seed: { identity: seed },
        });
        const orderedTargets = (values: typeof tiesFirst) =>
          values.map((result) => result.target.identity.canonicalKey);
        expect(orderedTargets(tiesFirst)).toEqual(["tie-a", "tie-b"]);
        expect(orderedTargets(tiesSecond)).toEqual(orderedTargets(tiesFirst));

        const oneFanout = await store.neighbors({
          ...queryBase(fixture, {
            domains: ["CODE"],
            relations: ["related"],
            maxFanout: 1,
          }),
          seed: { identity: seed },
        });
        expect(orderedTargets(oneFanout)).toEqual(["tie-a"]);

        const oneCandidate = await store.neighbors({
          ...queryBase(fixture, {
            domains: ["CODE"],
            relations: ["related"],
            maxCandidates: 1,
          }),
          seed: { identity: seed },
        });
        expect(orderedTargets(oneCandidate)).toEqual(["tie-a"]);

        const blockedByRelationPolicy = await store.neighbors({
          ...queryBase(fixture, {
            domains: ["CODE"],
            relations: ["does_not_exist"],
          }),
          seed: { identity: seed },
        });
        expect(blockedByRelationPolicy).toEqual([]);

        const incoming = await store.neighbors({
          ...queryBase(fixture, {
            domains: ["CODE"],
            relations: ["related"],
            direction: "incoming",
          }),
          seed: { identity: tieA },
        });
        expect(incoming).toHaveLength(1);
        expect(incoming[0]?.target.identity.canonicalKey).toBe("seed");
        expect(incoming[0]?.steps[0]?.direction).toBe("incoming");

        let fakeNow = 0;
        const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
          fakeNow += 2;
          return fakeNow;
        });
        try {
          await expect(
            store.paths({
              ...queryBase(fixture, {
                domains: ["CODE"],
                relations: ["calls"],
                maxHops: 5,
                timeBudgetMs: 1,
              }),
              seed: { identity: seed },
            }),
          ).rejects.toThrow("GRAPH_QUERY_TIME_BUDGET_EXCEEDED");
        } finally {
          nowSpy.mockRestore();
        }

        await expect(
          store.paths({
            ...queryBase(fixture, {
              domains: ["CODE"],
              relations: ["calls"],
              maxHops: 0,
            }),
            seed: { identity: seed },
          }),
        ).rejects.toThrow("GRAPH_MAX_HOPS_INVALID");
      } finally {
        await cleanupFixture(db, fixture).catch(() => undefined);
        await db.close();
      }
    },
  );
  it.skipIf(!databaseUrl)(
    "persists first-class relationship assertions and rebuilds to normalized graph equivalence",
    async () => {
      if (!databaseUrl) return;
      const db = new Postgres(databaseUrl);
      const fixture = await createFixture(db);
      const store = new PostgresFederatedGraphStore(db);
      try {
        const scopeId = "catalog:rebuild-equivalence";
        const revision = "catalog-rebuild-r1";
        const serviceA = identity(
          "SOFTWARE_CATALOG",
          scopeId,
          "service",
          "payments-api",
          revision,
        );
        const serviceB = identity(
          "SOFTWARE_CATALOG",
          scopeId,
          "service",
          "ledger-api",
          revision,
        );
        const projection = artifact({
          graphDomain: "SOFTWARE_CATALOG",
          spaceId: fixture.spaceId,
          vaultId: fixture.vaultA,
          scopeId,
          revision,
          nodes: [
            node(serviceA, fixture.vaultA, "allowed/catalog/payments", {
              name: "Payments API",
            }),
            node(serviceB, fixture.vaultA, "allowed/catalog/ledger", {
              name: "Ledger API",
            }),
          ],
          edges: [
            {
              from: serviceA,
              relation: "depends_on",
              to: serviceB,
              authorizationPath: "allowed/catalog/payments",
              assertionLifecycle: "ACTIVE",
              provenance: provenance("SOURCE_EXPLICIT", revision, {
                sourceIds: ["catalog:declared"],
                evidenceIds: ["evidence:catalog"],
              }),
            },
            {
              from: serviceA,
              relation: "depends_on",
              to: serviceB,
              authorizationPath: "allowed/catalog/payments",
              assertionLifecycle: "DISPUTED",
              provenance: provenance("HUMAN_ASSERTED", revision, {
                sourceIds: ["review:contradiction"],
                evidenceIds: ["evidence:review"],
              }),
            },
          ],
        });

        const normalizedState = async () => {
          const nodes = await db.pool.query<{
            kind: string;
            canonical_key: string;
            revision: string;
            authorization_path: string | null;
            payload: Record<string, unknown>;
          }>(
            `select kind,canonical_key,revision,authorization_path,payload
               from federated_graph_nodes
              where space_id=$1 and graph_domain='SOFTWARE_CATALOG'
                and scope_id=$2
              order by kind,canonical_key,revision,authorization_path nulls first`,
            [fixture.spaceId, scopeId],
          );
          const assertions = await db.pool.query<{
            from_kind: string;
            from_key: string;
            to_kind: string;
            to_key: string;
            relation_type: string;
            authorization_path: string | null;
            lifecycle: string;
            derivation: string;
            source_ids: string[];
            evidence_ids: string[];
            locator_refs: string[];
            provenance_revision: string;
            support_set_id: string | null;
            confidence: number | null;
            valid_from: string | null;
            valid_to: string | null;
            recorded_at: string;
            assertion_hash: string;
          }>(
            `select
               f.kind from_kind,f.canonical_key from_key,
               t.kind to_kind,t.canonical_key to_key,
               a.relation_type,a.authorization_path,a.lifecycle,a.derivation,
               a.source_ids,a.evidence_ids,a.locator_refs,
               a.provenance_revision,a.support_set_id,a.confidence,
               a.valid_from::text,a.valid_to::text,a.recorded_at::text,
               a.assertion_hash
             from federated_graph_relationship_assertions a
             join federated_graph_nodes f on f.id=a.from_node_id
             join federated_graph_nodes t on t.id=a.to_node_id
            where a.space_id=$1 and a.owner_graph_domain='SOFTWARE_CATALOG'
              and f.scope_id=$2
            order by
              f.kind,f.canonical_key,t.kind,t.canonical_key,
              a.relation_type,a.assertion_hash`,
            [fixture.spaceId, scopeId],
          );
          return { nodes: nodes.rows, assertions: assertions.rows };
        };

        await store.build(projection);
        const before = await normalizedState();
        expect(before.assertions).toHaveLength(2);
        expect(before.assertions.map((value) => value.lifecycle).sort()).toEqual(
          ["ACTIVE", "DISPUTED"],
        );

        const paths = await store.neighbors({
          ...queryBase(fixture, {
            domains: ["SOFTWARE_CATALOG"],
            relations: ["depends_on"],
          }),
          seed: { identity: serviceA },
        });
        expect(paths).toHaveLength(1);
        expect(GraphPathResult.safeParse(paths[0]).success).toBe(true);
        expect(paths[0]?.steps[0]?.assertion).toMatchObject({
          ownerGraphDomain: "SOFTWARE_CATALOG",
          relation: "depends_on",
          authorizationPath: "allowed/catalog/payments",
        });
        expect(paths[0]?.steps[0]?.assertion.id).toMatch(
          /^[0-9a-f-]{36}$/i,
        );

        await db.pool.query(
          `delete from federated_graph_projection_revisions
            where space_id=$1 and graph_domain='SOFTWARE_CATALOG'
              and scope_id=$2`,
          [fixture.spaceId, scopeId],
        );
        await db.pool.query(
          `delete from federated_graph_edges e
             using federated_graph_nodes f
            where e.from_node_id=f.id and e.space_id=$1
              and e.owner_graph_domain='SOFTWARE_CATALOG'
              and f.scope_id=$2`,
          [fixture.spaceId, scopeId],
        );
        await db.pool.query(
          `delete from federated_graph_relationship_assertions a
             using federated_graph_nodes f
            where a.from_node_id=f.id and a.space_id=$1
              and a.owner_graph_domain='SOFTWARE_CATALOG'
              and f.scope_id=$2`,
          [fixture.spaceId, scopeId],
        );
        await db.pool.query(
          `delete from federated_graph_nodes
            where space_id=$1 and graph_domain='SOFTWARE_CATALOG'
              and scope_id=$2`,
          [fixture.spaceId, scopeId],
        );

        expect(await normalizedState()).toEqual({
          nodes: [],
          assertions: [],
        });

        await store.build(projection);
        const after = await normalizedState();
        expect(after).toEqual(before);

        const rebuiltPaths = await store.neighbors({
          ...queryBase(fixture, {
            domains: ["SOFTWARE_CATALOG"],
            relations: ["depends_on"],
          }),
          seed: { identity: serviceA },
        });
        expect(rebuiltPaths).toHaveLength(1);
        expect(rebuiltPaths[0]?.steps[0]?.assertion.provenance).toEqual(
          paths[0]?.steps[0]?.assertion.provenance,
        );
        expect(rebuiltPaths[0]?.steps[0]?.assertion.lifecycle).toBe(
          paths[0]?.steps[0]?.assertion.lifecycle,
        );
      } finally {
        await cleanupFixture(db, fixture).catch(() => undefined);
        await db.close();
      }
    },
  );

});
