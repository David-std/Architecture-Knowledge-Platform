import { z } from "zod";

export const GraphDomain = z.enum([
  "EPISTEMIC",
  "SOFTWARE_CATALOG",
  "CODE",
  "RUNTIME",
  "TEMPORAL",
  "WORK",
  "COMMUNITY",
]);
export type GraphDomain = z.infer<typeof GraphDomain>;

export const GraphDerivation = z.enum([
  "SOURCE_EXPLICIT",
  "DETERMINISTIC_EXTRACTED",
  "STATICALLY_RESOLVED",
  "MODEL_INFERRED",
  "HUMAN_ASSERTED",
  "RUNTIME_OBSERVED",
  "DYNAMICALLY_PROVEN",
  "DERIVED_SUMMARY",
]);
export type GraphDerivation = z.infer<typeof GraphDerivation>;

export const GraphDirection = z.enum(["outgoing", "incoming", "both"]);
export type GraphDirection = z.infer<typeof GraphDirection>;

export const GraphFreshnessPolicy = z.enum(["FRESH_ONLY", "ALLOW_STALE"]);
export type GraphFreshnessPolicy = z.infer<typeof GraphFreshnessPolicy>;

export const GraphProjectionLifecycle = z.enum([
  "REQUESTED",
  "BUILT",
  "ACTIVE",
  "STALE",
  "FAILED",
]);
export type GraphProjectionLifecycle = z.infer<
  typeof GraphProjectionLifecycle
>;

export const GraphProjectionFreshness = z.enum(["FRESH", "STALE"]);
export type GraphProjectionFreshness = z.infer<
  typeof GraphProjectionFreshness
>;

export const GraphNodeIdentity = z.object({
  graphDomain: GraphDomain,
  scopeId: z.string().min(1).max(512),
  kind: z.string().min(1).max(120),
  canonicalKey: z.string().min(1).max(2048),
  revision: z.string().min(1).max(512),
});
export type GraphNodeIdentity = z.infer<typeof GraphNodeIdentity>;

export function graphNodeIdentityKey(identity: GraphNodeIdentity): string {
  const value = GraphNodeIdentity.parse(identity);
  return JSON.stringify([
    value.graphDomain,
    value.scopeId,
    value.kind,
    value.canonicalKey,
    value.revision,
  ]);
}

export const GraphProvenanceEnvelope = z
  .object({
    derivation: GraphDerivation,
    sourceIds: z.array(z.string().min(1).max(1024)).max(256),
    evidenceIds: z.array(z.string().min(1).max(1024)).max(256),
    locatorRefs: z.array(z.string().min(1).max(2048)).max(256),
    revision: z.string().min(1).max(512),
    supportSetId: z.string().min(1).max(1024).optional(),
    confidence: z.number().min(0).max(1).optional(),
    validFrom: z.string().datetime().optional(),
    validTo: z.string().datetime().optional(),
    recordedAt: z.string().datetime(),
  })
  .superRefine((value, context) => {
    if (
      value.validFrom &&
      value.validTo &&
      Date.parse(value.validTo) <= Date.parse(value.validFrom)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["validTo"],
        message: "validTo must be after validFrom",
      });
    }
  });
export type GraphProvenanceEnvelope = z.infer<
  typeof GraphProvenanceEnvelope
>;

export const GraphProjectionRevision = z.object({
  id: z.string().uuid(),
  graphDomain: GraphDomain,
  spaceId: z.string().uuid(),
  vaultId: z.string().uuid().nullable(),
  scopeId: z.string().min(1).max(512),
  revision: z.string().min(1).max(512),
  sourceRevision: z.string().min(1).max(1024),
  sourceHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  provider: z.string().min(1).max(160),
  providerVersion: z.string().min(1).max(160).nullable(),
  configurationVersion: z.string().min(1).max(512),
  lifecycle: GraphProjectionLifecycle,
  freshness: GraphProjectionFreshness,
  requestedAt: z.string().datetime(),
  builtAt: z.string().datetime().nullable(),
  activatedAt: z.string().datetime().nullable(),
  lastSuccessfulUpdate: z.string().datetime().nullable(),
});
export type GraphProjectionRevision = z.infer<
  typeof GraphProjectionRevision
>;

export const GraphNodeRef = z.object({
  id: z.string().uuid(),
  spaceId: z.string().uuid(),
  vaultId: z.string().uuid().nullable(),
  authorizationPath: z.string().nullable(),
  identity: GraphNodeIdentity,
  payload: z.record(z.string(), z.unknown()),
  projection: GraphProjectionRevision.pick({
    id: true,
    revision: true,
    lifecycle: true,
    freshness: true,
  }),
});
export type GraphNodeRef = z.infer<typeof GraphNodeRef>;

export const GraphPathStep = z.object({
  from: GraphNodeRef,
  relation: z.string().min(1).max(160),
  to: GraphNodeRef,
  provenance: GraphProvenanceEnvelope,
});
export type GraphPathStep = z.infer<typeof GraphPathStep>;

const revisionSetShape = z.object({
  EPISTEMIC: z.string().min(1).optional(),
  SOFTWARE_CATALOG: z.string().min(1).optional(),
  CODE: z.string().min(1).optional(),
  RUNTIME: z.string().min(1).optional(),
  TEMPORAL: z.string().min(1).optional(),
  WORK: z.string().min(1).optional(),
  COMMUNITY: z.string().min(1).optional(),
});

export const GraphPathResult = z.object({
  seed: GraphNodeRef,
  target: GraphNodeRef,
  steps: z.array(GraphPathStep),
  score: z.number().finite().optional(),
  revisionSet: revisionSetShape,
});
export type GraphPathResult = z.infer<typeof GraphPathResult>;

export const GraphTraversalBounds = z.object({
  maxHops: z.number().int().min(1).max(16),
  maxFanout: z.number().int().min(1).max(1000),
  maxCandidates: z.number().int().min(1).max(10000),
  timeBudgetMs: z.number().int().min(1).max(60000),
});
export type GraphTraversalBounds = z.infer<typeof GraphTraversalBounds>;

export interface GraphAuthorizationVaultScope {
  vaultId: string;
  pathPrefix: string | null;
}

export interface GraphAuthorizationScope {
  spaceId: string;
  vaults: readonly GraphAuthorizationVaultScope[];
  allowSpaceScoped?: boolean;
}

export interface GraphNodeSelector {
  nodeId?: string;
  identity?: GraphNodeIdentity;
}

export interface GraphQueryBase {
  authorization: GraphAuthorizationScope;
  domains?: readonly GraphDomain[];
  relationAllowlist: readonly string[];
  direction: GraphDirection;
  freshnessPolicy: GraphFreshnessPolicy;
  bounds: GraphTraversalBounds;
}

export interface GraphNeighborQuery extends GraphQueryBase {
  seed: GraphNodeSelector;
}

export interface GraphPathQuery extends GraphQueryBase {
  seed: GraphNodeSelector;
  target?: GraphNodeSelector;
}

export interface GraphImpactQuery extends GraphQueryBase {
  seed: GraphNodeSelector;
}

export interface GraphImpactResult {
  seed: GraphNodeRef;
  affected: GraphPathResult[];
  revisionSet: Partial<Record<GraphDomain, string>>;
}

export interface GraphProjectionRevisionState {
  graphDomain: GraphDomain;
  spaceId: string;
  vaultId: string | null;
  scopeId: string;
  requestedRevision: string | null;
  builtRevision: string | null;
  activeRevision: string | null;
  activeFreshness: GraphProjectionFreshness | null;
  lastSuccessfulUpdate: string | null;
}

export interface GraphProjectionNodeInput {
  identity: GraphNodeIdentity;
  vaultId: string | null;
  authorizationPath: string | null;
  payload: Record<string, unknown>;
}

export interface GraphProjectionEdgeInput {
  from: GraphNodeIdentity;
  relation: string;
  to: GraphNodeIdentity;
  authorizationPath?: string | null;
  provenance: GraphProvenanceEnvelope;
}

export interface GraphProjectionArtifact {
  graphDomain: GraphDomain;
  spaceId: string;
  vaultId: string | null;
  scopeId: string;
  revision: string;
  sourceRevision: string;
  sourceHash: string | null;
  provider: string;
  providerVersion: string | null;
  configurationVersion: string;
  nodes: readonly GraphProjectionNodeInput[];
  edges: readonly GraphProjectionEdgeInput[];
}

export interface GraphIncrementalUpdate<TArtifact> {
  baseRevision: string;
  next: TArtifact;
}

export interface GraphQueryPort {
  neighbors(input: GraphNeighborQuery): Promise<GraphPathResult[]>;
  paths(input: GraphPathQuery): Promise<GraphPathResult[]>;
  impact(input: GraphImpactQuery): Promise<GraphImpactResult>;
  revisionState(
    domain: GraphDomain,
    spaceId: string,
    scopeId: string,
  ): Promise<GraphProjectionRevisionState>;
}

export interface GraphProjectionPort<TArtifact = GraphProjectionArtifact> {
  build(input: TArtifact): Promise<GraphProjectionRevision>;
  update?(
    input: GraphIncrementalUpdate<TArtifact>,
  ): Promise<GraphProjectionRevision>;
}
