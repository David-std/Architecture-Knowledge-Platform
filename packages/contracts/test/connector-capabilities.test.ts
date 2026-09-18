import { describe, expect, it } from "vitest";
import {
  ConnectorCapabilities,
  connectorReadPlan,
  evaluateConnectorCapabilities,
} from "../src/connector-capabilities.js";
import { SOFTWARE_DELIVERY_KNOWLEDGE_PROFILE_V1 } from "../src/knowledge-profile.js";

const mirror = ConnectorCapabilities.parse({
  schemaVersion: 1,
  accessMode: "MIRROR_INDEXED",
  permissionFidelity: "SOURCE_ACL_EXACT",
  syncFidelity: "MIRROR",
  incrementalSync: true,
  deletionPropagation: "IMMEDIATE",
  freshnessSlaSeconds: 60,
  cursorOrWebhook: true,
  sourceAuthority: "SYSTEM_OF_RECORD",
  writeBack: "NONE",
  identityMapping: "EXACT",
  dataResidency: "ORG",
  replayable: true,
  auditTrail: "FULL",
  rateLimit: {
    kind: "DECLARED",
    requestsPerMinute: 600,
    burst: 60,
    onExceeded: "BACKOFF",
  },
  degradation: { onUnavailable: "STALE_READ", maxStaleSeconds: 900 },
  health: "HEALTHY",
});

const liveReference = ConnectorCapabilities.parse({
  schemaVersion: 1,
  accessMode: "REFERENCE_LIVE",
  permissionFidelity: "NONE",
  syncFidelity: "APPEND",
  incrementalSync: false,
  deletionPropagation: "NONE",
  cursorOrWebhook: false,
  sourceAuthority: "REFERENCE",
  writeBack: "NONE",
  identityMapping: "NONE",
  dataResidency: "EXTERNAL",
  replayable: false,
  auditTrail: "METADATA_ONLY",
  rateLimit: {
    kind: "DECLARED",
    requestsPerMinute: 120,
    onExceeded: "FAIL_CLOSED",
  },
  degradation: { onUnavailable: "FAIL_CLOSED" },
  health: "HEALTHY",
});

describe("ConnectorCapabilities", () => {
  it("models MIRROR_INDEXED and REFERENCE_LIVE as operationally different reads", () => {
    expect(connectorReadPlan(mirror)).toMatchObject({
      primaryRead: "LOCAL_INDEX",
      storesContent: "FULL_MIRROR",
      requiresLiveProvider: false,
      supportsOfflineRead: true,
    });
    expect(connectorReadPlan(liveReference)).toMatchObject({
      primaryRead: "LIVE_REFERENCE",
      storesContent: "NONE",
      requiresLiveProvider: true,
      supportsOfflineRead: false,
    });
  });

  it("fails closed when a profile requires source-permission fidelity", () => {
    const policy = SOFTWARE_DELIVERY_KNOWLEDGE_PROFILE_V1.connectorPolicy;
    expect(policy).toBeDefined();
    expect(evaluateConnectorCapabilities(mirror, policy!)).toEqual({
      status: "ALLOWED",
      permissionFidelitySatisfied: true,
      reasons: [],
    });
    expect(evaluateConnectorCapabilities(liveReference, policy!)).toEqual({
      status: "DENIED",
      permissionFidelitySatisfied: false,
      reasons: ["PERMISSION_FIDELITY_INSUFFICIENT"],
    });
  });

  it("does not let a remote-only connector promise stale local content", () => {
    const invalid = {
      ...liveReference,
      degradation: { onUnavailable: "STALE_READ", maxStaleSeconds: 60 },
    };
    expect(ConnectorCapabilities.safeParse(invalid).success).toBe(false);
  });

  it("requires identity mapping when source ACLs are mapped", () => {
    const invalid = {
      ...mirror,
      permissionFidelity: "SOURCE_ACL_MAPPED",
      identityMapping: "NONE",
    };
    expect(ConnectorCapabilities.safeParse(invalid).success).toBe(false);
  });

  it("exposes stale mirrored state explicitly instead of pretending it is current", () => {
    const unavailableMirror = ConnectorCapabilities.parse({
      ...mirror,
      health: "UNAVAILABLE",
    });
    expect(connectorReadPlan(unavailableMirror)).toMatchObject({
      availability: "STALE_LOCAL",
      staleDisclosureRequired: true,
    });
  });
});
