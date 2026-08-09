import type {
  ContextPacket,
  IngestRequest,
  SearchRequest,
  SearchHit,
} from "@akp/contracts";
import type { JobId } from "@akp/domain";

export interface SearchPort {
  search(request: SearchRequest): Promise<SearchHit[]>;
}

export interface ContextPacketPort {
  build(
    request: SearchRequest & { maxTokens: number; intent: string },
  ): Promise<ContextPacket>;
}

export interface IngestJobPort {
  submit(request: IngestRequest, actorId: string): Promise<JobId>;
  status(jobId: JobId): Promise<{ id: JobId; state: string; error?: string }>;
}

export interface AuditPort {
  append(event: {
    actorId: string;
    action: string;
    resourceType: string;
    resourceId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void>;
}

export class SubmitIngest {
  constructor(
    private readonly jobs: IngestJobPort,
    private readonly audit: AuditPort,
  ) {}

  async execute(request: IngestRequest, actorId: string): Promise<JobId> {
    const jobId = await this.jobs.submit(request, actorId);
    await this.audit.append({
      actorId,
      action: "ingest.submit",
      resourceType: "ingest_job",
      resourceId: jobId,
      metadata: { sourceUri: request.sourceUri, spaceId: request.spaceId },
    });
    return jobId;
  }
}
