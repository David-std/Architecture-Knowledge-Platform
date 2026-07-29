export interface AuditEvent {
  action: string;
  actorId?: string;
  resourceType: string;
  resourceId?: string;
  traceId?: string;
  metadata?: Record<string, unknown>;
}

export interface Telemetry {
  counter(name: string, value?: number, attributes?: Record<string, string>): void;
  histogram(name: string, value: number, attributes?: Record<string, string>): void;
  audit(event: AuditEvent): Promise<void>;
}

export class ConsoleTelemetry implements Telemetry {
  counter(name: string, value = 1, attributes: Record<string, string> = {}): void {
    console.log(JSON.stringify({ kind: "counter", name, value, attributes }));
  }

  histogram(name: string, value: number, attributes: Record<string, string> = {}): void {
    console.log(JSON.stringify({ kind: "histogram", name, value, attributes }));
  }

  async audit(event: AuditEvent): Promise<void> {
    console.log(JSON.stringify({ kind: "audit", ...event }));
  }
}
