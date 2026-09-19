import { z } from "zod";

export const ConnectorAccessMode = z.enum([
  "MIRROR_INDEXED",
  "REMOTE_FEDERATED",
  "REFERENCE_LIVE",
  "HYBRID_CACHE",
]);
export type ConnectorAccessMode = z.infer<typeof ConnectorAccessMode>;

export const PermissionFidelity = z.enum([
  "SOURCE_ACL_EXACT",
  "SOURCE_ACL_MAPPED",
  "WORKSPACE_WIDE",
  "NONE",
  "UNKNOWN",
]);
export type PermissionFidelity = z.infer<typeof PermissionFidelity>;

export const SyncFidelity = z.enum(["APPEND", "UPSERT", "MIRROR"]);
export type SyncFidelity = z.infer<typeof SyncFidelity>;

export const ConnectorRateLimit = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("NONE") }).strict(),
  z
    .object({
      kind: z.literal("DECLARED"),
      requestsPerMinute: z.number().int().positive(),
      burst: z.number().int().positive().optional(),
      onExceeded: z.enum(["BACKOFF", "QUEUE", "FAIL_CLOSED"]),
    })
    .strict(),
]);
export type ConnectorRateLimit = z.infer<typeof ConnectorRateLimit>;

export const ConnectorDegradationPolicy = z
  .object({
    onUnavailable: z.enum(["FAIL_CLOSED", "STALE_READ"]),
    maxStaleSeconds: z.number().int().nonnegative().optional(),
  })
  .strict()
  .superRefine((policy, context) => {
    if (
      policy.onUnavailable === "STALE_READ" &&
      policy.maxStaleSeconds === undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["maxStaleSeconds"],
        message: "STALE_READ requires an explicit maxStaleSeconds bound",
      });
    }
    if (
      policy.onUnavailable === "FAIL_CLOSED" &&
      policy.maxStaleSeconds !== undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["maxStaleSeconds"],
        message: "maxStaleSeconds is only valid for STALE_READ",
      });
    }
  });
export type ConnectorDegradationPolicy = z.infer<
  typeof ConnectorDegradationPolicy
>;

export const ConnectorCapabilities = z
  .object({
    schemaVersion: z.literal(1),
    accessMode: ConnectorAccessMode,
    permissionFidelity: PermissionFidelity,
    syncFidelity: SyncFidelity,
    incrementalSync: z.boolean(),
    deletionPropagation: z.enum(["IMMEDIATE", "EVENTUAL", "NONE"]),
    freshnessSlaSeconds: z.number().int().positive().optional(),
    cursorOrWebhook: z.boolean(),
    sourceAuthority: z.enum(["SYSTEM_OF_RECORD", "REFERENCE", "DERIVED"]),
    writeBack: z.enum(["NONE", "BOUNDED_ACTIONS", "FULL"]),
    identityMapping: z.enum(["EXACT", "MAPPED", "NONE"]),
    dataResidency: z.enum(["LOCAL", "ORG", "EXTERNAL"]),
    replayable: z.boolean(),
    auditTrail: z.enum(["FULL", "METADATA_ONLY", "NONE"]),
    rateLimit: ConnectorRateLimit,
    degradation: ConnectorDegradationPolicy,
    health: z.enum(["HEALTHY", "DEGRADED", "STALE", "UNAVAILABLE"]),
  })
  .strict()
  .superRefine((capabilities, context) => {
    if (
      (capabilities.accessMode === "REMOTE_FEDERATED" ||
        capabilities.accessMode === "REFERENCE_LIVE") &&
      capabilities.degradation.onUnavailable === "STALE_READ"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["degradation", "onUnavailable"],
        message:
          "remote/reference-only connectors cannot promise stale local content",
      });
    }
    if (
      capabilities.permissionFidelity === "SOURCE_ACL_MAPPED" &&
      capabilities.identityMapping === "NONE"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["identityMapping"],
        message:
          "SOURCE_ACL_MAPPED requires an identity mapping that can reproduce principals",
      });
    }
  });
export type ConnectorCapabilities = z.infer<typeof ConnectorCapabilities>;

export interface ConnectorAcceptancePolicy {
  allowedAccessModes: ConnectorAccessMode[];
  requirePermissionFidelity: boolean;
}

export interface ConnectorCompatibility {
  status: "ALLOWED" | "DENIED";
  permissionFidelitySatisfied: boolean;
  reasons: Array<
    "ACCESS_MODE_NOT_ALLOWED" | "PERMISSION_FIDELITY_INSUFFICIENT"
  >;
}

function permissionFidelitySatisfied(
  capabilities: ConnectorCapabilities,
): boolean {
  return (
    capabilities.permissionFidelity === "SOURCE_ACL_EXACT" ||
    (capabilities.permissionFidelity === "SOURCE_ACL_MAPPED" &&
      capabilities.identityMapping !== "NONE")
  );
}

export function evaluateConnectorCapabilities(
  capabilities: ConnectorCapabilities,
  policy: ConnectorAcceptancePolicy,
): ConnectorCompatibility {
  const reasons: ConnectorCompatibility["reasons"] = [];
  if (!policy.allowedAccessModes.includes(capabilities.accessMode)) {
    reasons.push("ACCESS_MODE_NOT_ALLOWED");
  }
  const faithful = permissionFidelitySatisfied(capabilities);
  if (policy.requirePermissionFidelity && !faithful) {
    reasons.push("PERMISSION_FIDELITY_INSUFFICIENT");
  }
  return {
    status: reasons.length === 0 ? "ALLOWED" : "DENIED",
    permissionFidelitySatisfied: faithful,
    reasons,
  };
}

export interface ConnectorReadPlan {
  accessMode: ConnectorAccessMode;
  primaryRead:
    | "LOCAL_INDEX"
    | "REMOTE_QUERY"
    | "LIVE_REFERENCE"
    | "BOUNDED_CACHE_THEN_LIVE";
  storesContent: "FULL_MIRROR" | "BOUNDED_CACHE" | "NONE";
  storesMetadata: boolean;
  requiresLiveProvider: boolean;
  supportsOfflineRead: boolean;
  revalidatesLive: boolean;
  health: ConnectorCapabilities["health"];
  availability: "READY" | "DEGRADED" | "STALE" | "STALE_LOCAL" | "UNAVAILABLE";
  staleDisclosureRequired: boolean;
}

export function connectorReadPlan(
  capabilities: ConnectorCapabilities,
): ConnectorReadPlan {
  const base = (() => {
    switch (capabilities.accessMode) {
      case "MIRROR_INDEXED":
        return {
          primaryRead: "LOCAL_INDEX" as const,
          storesContent: "FULL_MIRROR" as const,
          storesMetadata: true,
          requiresLiveProvider: false,
          supportsOfflineRead: true,
          revalidatesLive: false,
        };
      case "REMOTE_FEDERATED":
        return {
          primaryRead: "REMOTE_QUERY" as const,
          storesContent: "NONE" as const,
          storesMetadata: false,
          requiresLiveProvider: true,
          supportsOfflineRead: false,
          revalidatesLive: true,
        };
      case "REFERENCE_LIVE":
        return {
          primaryRead: "LIVE_REFERENCE" as const,
          storesContent: "NONE" as const,
          storesMetadata: true,
          requiresLiveProvider: true,
          supportsOfflineRead: false,
          revalidatesLive: true,
        };
      case "HYBRID_CACHE":
        return {
          primaryRead: "BOUNDED_CACHE_THEN_LIVE" as const,
          storesContent: "BOUNDED_CACHE" as const,
          storesMetadata: true,
          requiresLiveProvider: true,
          supportsOfflineRead: true,
          revalidatesLive: true,
        };
    }
  })();

  let availability: ConnectorReadPlan["availability"];
  if (capabilities.health === "HEALTHY") {
    availability = "READY";
  } else if (capabilities.health === "DEGRADED") {
    availability = "DEGRADED";
  } else if (capabilities.health === "STALE") {
    availability = "STALE";
  } else if (
    capabilities.degradation.onUnavailable === "STALE_READ" &&
    (capabilities.accessMode === "MIRROR_INDEXED" ||
      capabilities.accessMode === "HYBRID_CACHE")
  ) {
    availability = "STALE_LOCAL";
  } else {
    availability = "UNAVAILABLE";
  }

  return {
    accessMode: capabilities.accessMode,
    ...base,
    health: capabilities.health,
    availability,
    staleDisclosureRequired:
      availability === "STALE" || availability === "STALE_LOCAL",
  };
}
