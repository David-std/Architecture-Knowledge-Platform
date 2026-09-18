import { z } from "zod";

export const TruthSupportState = z.enum(["SUPPORTED", "DISPUTED"]);
export type TruthSupportState = z.infer<typeof TruthSupportState>;

export const TruthSupportEvaluation = z.enum([
  "SUPPORTED",
  "DISPUTED",
  "UNSUPPORTED",
]);
export type TruthSupportEvaluation = z.infer<typeof TruthSupportEvaluation>;

export const TemporalFactLifecycle = z.enum(["ACTIVE", "DISPUTED"]);
export type TemporalFactLifecycle = z.infer<typeof TemporalFactLifecycle>;

export const SourceEpisode = z.object({
  id: z.string().uuid(),
  spaceId: z.string().uuid(),
  vaultId: z.string().uuid(),
  sourceId: z.string().uuid(),
  sourceArtifactId: z.string().uuid(),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  observedAt: z.string().datetime().nullable(),
  ingestedAt: z.string().datetime(),
  locatorRefs: z.array(z.string().min(1).max(2048)).max(500),
});
export type SourceEpisode = z.infer<typeof SourceEpisode>;

export const TruthSupportSet = z.object({
  schemaVersion: z.literal(1),
  id: z.string().uuid(),
  spaceId: z.string().uuid(),
  vaultId: z.string().uuid(),
  state: TruthSupportState,
  factIds: z.array(z.string().uuid()).max(500),
  evidenceIds: z.array(z.string().uuid()).max(500),
  sourceArtifactIds: z.array(z.string().uuid()).max(500),
  sourceRevisionHashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(500),
  sourceEpisodeIds: z.array(z.string().uuid()).max(500),
  alternativeSupportGroups: z
    .array(z.array(z.string().min(1).max(2200)).min(1).max(100))
    .max(100),
  createdAt: z.string().datetime(),
});
export type TruthSupportSet = z.infer<typeof TruthSupportSet>;

export const TruthRevision = z.object({
  id: z.string().uuid(),
  spaceId: z.string().uuid(),
  vaultId: z.string().uuid(),
  revisionSeq: z.number().int().positive(),
  revisionHash: z.string().regex(/^[a-f0-9]{64}$/),
  parentRevisionHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  reason: z.string().min(1).max(120),
  resourceType: z.string().min(1).max(120),
  resourceId: z.string().min(1).max(2048),
  createdAt: z.string().datetime(),
});
export type TruthRevision = z.infer<typeof TruthRevision>;

export const TemporalFact = z.object({
  id: z.string().uuid(),
  spaceId: z.string().uuid(),
  vaultId: z.string().uuid(),
  scopeId: z.string().min(1).max(512),
  authorizationPath: z.string().min(1).max(4096),
  subjectRef: z.string().min(1).max(2048),
  predicate: z.string().min(1).max(512),
  object: z.unknown(),
  validFrom: z.string().datetime(),
  validTo: z.string().datetime().nullable(),
  recordedAt: z.string().datetime(),
  sourceEpisodeId: z.string().uuid().nullable(),
  supportSetId: z.string().uuid(),
  lifecycle: TemporalFactLifecycle,
  truthRevisionHash: z.string().regex(/^[a-f0-9]{64}$/),
  truthRevisionSeq: z.number().int().positive(),
});
export type TemporalFact = z.infer<typeof TemporalFact>;

export const TemporalFactView = TemporalFact.extend({
  supportState: TruthSupportEvaluation,
  queryRevisionHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  queryRevisionSeq: z.number().int().nonnegative(),
});
export type TemporalFactView = z.infer<typeof TemporalFactView>;

export const CreateSourceEpisodeInput = z.object({
  spaceId: z.string().uuid(),
  vaultId: z.string().uuid(),
  sourceId: z.string().uuid(),
  sourceArtifactId: z.string().uuid(),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  observedAt: z.string().datetime().nullable().optional(),
  ingestedAt: z.string().datetime().optional(),
  locatorRefs: z.array(z.string().min(1).max(2048)).max(500).default([]),
});
export type CreateSourceEpisodeInput = z.infer<typeof CreateSourceEpisodeInput>;

export const CreateTruthSupportSetInput = z.object({
  spaceId: z.string().uuid(),
  vaultId: z.string().uuid(),
  state: TruthSupportState.default("SUPPORTED"),
  factIds: z.array(z.string().uuid()).max(500).default([]),
  evidenceIds: z.array(z.string().uuid()).max(500).default([]),
  sourceArtifactIds: z.array(z.string().uuid()).max(500).default([]),
  sourceRevisionHashes: z
    .array(z.string().regex(/^[a-f0-9]{64}$/))
    .max(500)
    .default([]),
  sourceEpisodeIds: z.array(z.string().uuid()).max(500).default([]),
  alternativeSupportGroups: z
    .array(z.array(z.string().min(1).max(2200)).min(1).max(100))
    .max(100)
    .default([]),
});
export type CreateTruthSupportSetInput = z.infer<
  typeof CreateTruthSupportSetInput
>;

export const RecordTemporalFactInput = z
  .object({
    spaceId: z.string().uuid(),
    vaultId: z.string().uuid(),
    scopeId: z.string().min(1).max(512),
    authorizationPath: z.string().min(1).max(4096),
    subjectRef: z.string().min(1).max(2048),
    predicate: z.string().min(1).max(512),
    object: z.unknown(),
    validFrom: z.string().datetime(),
    validTo: z.string().datetime().nullable().optional(),
    recordedAt: z.string().datetime().optional(),
    sourceEpisodeId: z.string().uuid().nullable().optional(),
    supportSetId: z.string().uuid(),
    lifecycle: TemporalFactLifecycle.default("ACTIVE"),
    supersedesFactId: z.string().uuid().optional(),
  })
  .superRefine((value, context) => {
    if (
      value.validTo &&
      new Date(value.validTo).getTime() <= new Date(value.validFrom).getTime()
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["validTo"],
        message: "validTo must be after validFrom",
      });
    }
  });
export type RecordTemporalFactInput = z.infer<typeof RecordTemporalFactInput>;

export const TemporalTruthQuery = z.object({
  spaceId: z.string().uuid(),
  vaultId: z.string().uuid(),
  subjectRef: z.string().min(1).max(2048).optional(),
  predicate: z.string().min(1).max(512).optional(),
  mode: z.enum(["CURRENT", "HISTORY"]).default("CURRENT"),
  validAt: z.string().datetime().optional(),
  recordedAtOrBefore: z.string().datetime().optional(),
  truthRevisionHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  changedSince: z.string().datetime().optional(),
  authorizationPathPrefixes: z
    .array(z.string().min(1).max(4096).nullable())
    .max(100)
    .default([]),
  limit: z.number().int().min(1).max(1000).default(100),
});
export type TemporalTruthQuery = z.infer<typeof TemporalTruthQuery>;
