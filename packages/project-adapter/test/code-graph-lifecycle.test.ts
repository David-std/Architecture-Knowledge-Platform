import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  CodeGraphArtifact,
  CodeGraphExtractionPort,
  CodeGraphOptions,
  CodeSnapshot,
  GraphProjectionArtifact,
  GraphProjectionRevision,
  GraphProjectionRevisionState,
} from "@akp/contracts";
import {
  CodeGraphLifecycleCoordinator,
  type CodeGraphLifecyclePort,
} from "../src/index.js";

function revision(input: {
  revision: string;
  sourceRevision: string;
  freshness?: "FRESH" | "STALE";
}): GraphProjectionRevision {
  return {
    id: randomUUID(),
    graphDomain: "CODE",
    spaceId: "00000000-0000-0000-0000-000000000003",
    vaultId: "00000000-0000-0000-0000-000000000004",
    scopeId: "repo:fixture",
    revision: input.revision,
    sourceRevision: input.sourceRevision,
    sourceHash: null,
    provider: "graphify",
    providerVersion: "0.9.99",
    configurationVersion: "a".repeat(64),
    lifecycle: "ACTIVE",
    freshness: input.freshness ?? "FRESH",
    requestedAt: "2026-09-18T00:00:00.000Z",
    builtAt: "2026-09-18T00:00:01.000Z",
    activatedAt: "2026-09-18T00:00:02.000Z",
    lastSuccessfulUpdate: "2026-09-18T00:00:02.000Z",
  };
}

function state(active: GraphProjectionRevision | null): GraphProjectionRevisionState {
  return {
    graphDomain: "CODE",
    spaceId: "00000000-0000-0000-0000-000000000003",
    vaultId: active?.vaultId ?? null,
    scopeId: "repo:fixture",
    requested: active,
    built: active,
    active,
    requestedRevision: active?.revision ?? null,
    builtRevision: active?.revision ?? null,
    activeRevision: active?.revision ?? null,
    activeFreshness: active?.freshness ?? null,
    lastSuccessfulUpdate: active?.lastSuccessfulUpdate ?? null,
  };
}

function snapshot(commitSha: string): CodeSnapshot {
  return {
    repository: "fixture",
    repositoryPath: "/tmp/fixture",
    commitSha,
    treeHash: "b".repeat(40),
    files: [],
  };
}

function options(): CodeGraphOptions {
  return {
    exclusions: { patterns: [], maxFileBytes: 1024 },
    timeoutMs: 1000,
    maxProcessOutputBytes: 1024,
    maxGraphBytes: 1024,
    providerConfiguration: {},
  };
}

function artifact(commitSha: string): CodeGraphArtifact {
  return {
    schemaVersion: 1,
    repository: "fixture",
    commitSha,
    provider: "graphify",
    providerVersion: "0.9.99",
    configurationHash: "a".repeat(64),
    generatedAt: "2026-09-18T00:00:03.000Z",
    languages: [],
    nodes: [],
    edges: [],
    warnings: [],
  };
}

class FakeProjectionPort implements CodeGraphLifecyclePort {
  current: GraphProjectionRevision | null;
  readonly calls: string[] = [];

  constructor(active: GraphProjectionRevision | null) {
    this.current = active;
  }

  async revisionState(): Promise<GraphProjectionRevisionState> {
    this.calls.push("state");
    return state(this.current);
  }

  async markStale(): Promise<GraphProjectionRevision | null> {
    this.calls.push("stale");
    if (!this.current) return null;
    this.current = { ...this.current, freshness: "STALE" };
    return this.current;
  }

  async build(input: GraphProjectionArtifact): Promise<GraphProjectionRevision> {
    this.calls.push("build");
    this.current = revision({
      revision: input.revision,
      sourceRevision: input.sourceRevision,
    });
    return this.current;
  }
}

describe("CodeGraphLifecycleCoordinator", () => {
  it("marks the old commit stale before extraction and atomically replaces it", async () => {
    const oldCommit = "1".repeat(40);
    const nextCommit = "2".repeat(40);
    const port = new FakeProjectionPort(
      revision({ revision: "old", sourceRevision: oldCommit }),
    );
    const extraction: CodeGraphExtractionPort = {
      async analyze() {
        port.calls.push("extract");
        return artifact(nextCommit);
      },
    };
    const coordinator = new CodeGraphLifecycleCoordinator(extraction, port);

    const result = await coordinator.refresh({
      snapshot: snapshot(nextCommit),
      options: options(),
      spaceId: "00000000-0000-0000-0000-000000000003",
      vaultId: "00000000-0000-0000-0000-000000000004",
      scopeId: "repo:fixture",
    });

    expect(port.calls).toEqual(["state", "stale", "extract", "state", "build"]);
    expect(result.previous?.freshness).toBe("STALE");
    expect(result.active.sourceRevision).toBe(nextCommit);
    expect(result.active.freshness).toBe("FRESH");
    expect(result.degradedDuringRefresh).toBe(true);
  });

  it("leaves the previous projection stale when extraction fails", async () => {
    const oldCommit = "3".repeat(40);
    const nextCommit = "4".repeat(40);
    const port = new FakeProjectionPort(
      revision({ revision: "old", sourceRevision: oldCommit }),
    );
    const extraction: CodeGraphExtractionPort = {
      async analyze() {
        port.calls.push("extract");
        throw new Error("synthetic extraction failure");
      },
    };
    const coordinator = new CodeGraphLifecycleCoordinator(extraction, port);

    await expect(
      coordinator.refresh({
        snapshot: snapshot(nextCommit),
        options: options(),
        spaceId: "00000000-0000-0000-0000-000000000003",
        vaultId: "00000000-0000-0000-0000-000000000004",
        scopeId: "repo:fixture",
      }),
    ).rejects.toThrow("synthetic extraction failure");
    expect(port.calls).toEqual(["state", "stale", "extract"]);
    expect(port.current?.freshness).toBe("STALE");
    expect(port.current?.sourceRevision).toBe(oldCommit);
  });
});
