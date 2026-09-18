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
  planCodeGraphProjection,
  type CodeGraphProjectionPlan,
} from "./code-graph-projection.js";

export interface CodeGraphLifecyclePort {
  build(input: GraphProjectionArtifact): Promise<GraphProjectionRevision>;
  markStale(
    domain: "CODE",
    spaceId: string,
    scopeId: string,
    reason?: string,
  ): Promise<GraphProjectionRevision | null>;
  revisionState(
    domain: "CODE",
    spaceId: string,
    scopeId: string,
  ): Promise<GraphProjectionRevisionState>;
}

export interface RefreshCodeGraphInput {
  snapshot: CodeSnapshot;
  options: CodeGraphOptions;
  spaceId: string;
  vaultId: string | null;
  scopeId: string;
}

export interface RefreshCodeGraphResult {
  artifact: CodeGraphArtifact;
  plan: CodeGraphProjectionPlan;
  active: GraphProjectionRevision;
  previous: GraphProjectionRevision | null;
  degradedDuringRefresh: boolean;
}

export class CodeGraphLifecycleCoordinator {
  constructor(
    private readonly extraction: CodeGraphExtractionPort,
    private readonly projections: CodeGraphLifecyclePort,
  ) {}

  async refresh(input: RefreshCodeGraphInput): Promise<RefreshCodeGraphResult> {
    const before = await this.projections.revisionState(
      "CODE",
      input.spaceId,
      input.scopeId,
    );
    let stale = before.active;
    let degradedDuringRefresh = false;

    // A newly observed immutable commit invalidates the active CODE projection
    // before extraction begins. If extraction fails, the previous revision
    // remains ACTIVE but explicitly STALE and queryable only under a degraded
    // freshness policy.
    if (
      before.active &&
      before.active.sourceRevision !== input.snapshot.commitSha &&
      before.active.freshness !== "STALE"
    ) {
      stale = await this.projections.markStale(
        "CODE",
        input.spaceId,
        input.scopeId,
        "repository commit changed from " +
          before.active.sourceRevision +
          " to " +
          input.snapshot.commitSha,
      );
      degradedDuringRefresh = stale !== null;
    }

    const artifact = await this.extraction.analyze(
      input.snapshot,
      input.options,
    );
    const plan = planCodeGraphProjection({
      artifact,
      spaceId: input.spaceId,
      vaultId: input.vaultId,
      scopeId: input.scopeId,
    });

    const current = await this.projections.revisionState(
      "CODE",
      input.spaceId,
      input.scopeId,
    );
    if (
      current.active &&
      current.active.revision !== plan.projection.revision &&
      current.active.freshness !== "STALE"
    ) {
      stale = await this.projections.markStale(
        "CODE",
        input.spaceId,
        input.scopeId,
        "code graph extraction or provider configuration changed",
      );
      degradedDuringRefresh = stale !== null;
    }

    const active = await this.projections.build(plan.projection);
    return {
      artifact,
      plan,
      active,
      previous: stale ?? before.active,
      degradedDuringRefresh,
    };
  }
}
