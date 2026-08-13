import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import {
  acknowledgeEventDelivery,
  claimNextEventDelivery,
  failEventDelivery,
  heartbeatEventDelivery,
  registerEventConsumer,
  type EventDeliveryClaim,
  type OutboxEventRecord,
  type Postgres,
  type RetryPolicy,
  DEFAULT_RETRY_POLICY,
} from "@akp/postgres";

export type EventHandler = (event: OutboxEventRecord) => Promise<void>;
export type EventHandlers = Partial<
  Record<OutboxEventRecord["eventType"], EventHandler>
>;

export interface DurableEventWorkerOptions {
  consumerName: string;
  workerId?: string;
  maxAttempts?: number;
  leaseSeconds?: number;
  idleDelayMs?: number;
  retryPolicy?: RetryPolicy;
  handlers?: EventHandlers;
  /** Used only when no event-specific handler was supplied. */
  defaultHandler?: EventHandler;
  /** Explicitly accepted schema versions; omitted means version 1 only. */
  supportedVersions?: Readonly<Record<string, readonly number[]>>;
  /** Disable LISTEN/NOTIFY when a deployment disallows it. */
  listenNotify?: boolean;
}

export interface EventWorkerRunOptions {
  drain?: boolean;
  signal?: AbortSignal;
}

/**
 * Durable PostgreSQL-backed consumer.  The event row is immutable; delivery
 * state, attempts, quarantine and fencing live in the postgres outbox module.
 * A handler may safely run more than once for the same event and should make
 * its own writes idempotent (the delivery key is event id + consumer name).
 */
export class DurableEventWorker {
  readonly workerId: string;
  readonly consumerName: string;
  private readonly handlers: EventHandlers;
  private readonly defaultHandler: EventHandler;
  private readonly retryPolicy: RetryPolicy;
  private readonly maxAttempts: number;
  private readonly leaseSeconds: number;
  private readonly idleDelayMs: number;
  private readonly listenNotify: boolean;
  private readonly supportedVersions: Readonly<
    Record<string, readonly number[]>
  >;
  private stopped = false;

  constructor(
    private readonly db: Postgres,
    options: DurableEventWorkerOptions,
  ) {
    if (!options.consumerName.trim()) throw new Error("CONSUMER_NAME_REQUIRED");
    this.consumerName = options.consumerName;
    this.workerId =
      options.workerId ?? `${hostname()}:${process.pid}:events:${randomUUID()}`;
    this.handlers = options.handlers ?? {};
    this.defaultHandler = options.defaultHandler ?? (async () => undefined);
    this.retryPolicy = options.retryPolicy ?? DEFAULT_RETRY_POLICY;
    this.maxAttempts = options.maxAttempts ?? 8;
    this.leaseSeconds = options.leaseSeconds ?? 60;
    this.idleDelayMs = Math.max(100, options.idleDelayMs ?? 1_000);
    this.listenNotify = options.listenNotify ?? true;
    this.supportedVersions = options.supportedVersions ?? {};
  }

  async register(): Promise<void> {
    await registerEventConsumer(this.db, this.consumerName, {
      maxAttempts: this.maxAttempts,
      leaseSeconds: this.leaseSeconds,
    });
  }

  stop(): void {
    this.stopped = true;
  }

  /** Process at most one delivery. Returns false when the queue is empty. */
  async runOnce(): Promise<boolean> {
    if (this.stopped) return false;
    const claim = await claimNextEventDelivery(
      this.db,
      this.consumerName,
      this.workerId,
    );
    if (!claim) return false;
    const stopHeartbeat = this.startHeartbeat(claim);
    try {
      const supported = this.supportedVersions[claim.event.eventType] ?? [1];
      if (!supported.includes(claim.event.eventVersion)) {
        throw new Error(
          `UNSUPPORTED_EVENT_VERSION:${claim.event.eventType}:${claim.event.eventVersion}`,
        );
      }
      const handler =
        this.handlers[claim.event.eventType] ?? this.defaultHandler;
      await handler(claim.event);
      await acknowledgeEventDelivery(this.db, claim);
    } catch (error) {
      // A stale worker cannot mutate a newer fenced claim.  Surface only
      // unexpected database failures; ordinary handler failures are persisted
      // as RETRY or QUARANTINED by failEventDelivery.
      try {
        await failEventDelivery(this.db, claim, error, this.retryPolicy);
      } catch (failureError) {
        if (
          failureError instanceof Error &&
          failureError.message === "EVENT_LEASE_LOST"
        ) {
          // Another worker owns the fencing token; this attempt is already
          // represented by durable delivery state and must not be retried by
          // the stale process.
          return true;
        }
        throw failureError;
      }
    } finally {
      stopHeartbeat();
    }
    return true;
  }

  async run(options: EventWorkerRunOptions = {}): Promise<void> {
    await this.register();
    const drain = options.drain ?? false;
    while (!this.stopped && !options.signal?.aborted) {
      const handled = await this.runOnce();
      if (handled) continue;
      if (drain) return;
      await this.waitForWakeup(options.signal);
    }
  }

  private startHeartbeat(claim: EventDeliveryClaim): () => void {
    let inFlight = false;
    const interval = setInterval(
      () => {
        if (inFlight || this.stopped) return;
        inFlight = true;
        void heartbeatEventDelivery(this.db, claim)
          .catch(() => undefined)
          .finally(() => {
            inFlight = false;
          });
      },
      Math.max(5_000, Math.floor((this.leaseSeconds * 1_000) / 3)),
    );
    interval.unref();
    return () => clearInterval(interval);
  }

  /**
   * LISTEN/NOTIFY is only a wake-up hint; claimNextEventDelivery remains the
   * source of truth and polling resumes after a bounded timeout.
   */
  private async waitForWakeup(signal?: AbortSignal): Promise<void> {
    if (!this.listenNotify) {
      await this.sleep(this.idleDelayMs, signal);
      return;
    }
    const client = await this.db.pool.connect();
    await client.query("listen akp_outbox");
    try {
      await new Promise<void>((resolve) => {
        let settled = false;
        const timer = setTimeout(finish, this.idleDelayMs);
        const onAbort = () => finish();
        const onNotification = (message: { channel?: string }) => {
          if (message.channel === "akp_outbox") finish();
        };
        const cleanup = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          client.removeListener("notification", onNotification);
        };
        function finish(): void {
          if (settled) return;
          settled = true;
          cleanup();
          resolve();
        }
        signal?.addEventListener("abort", onAbort, { once: true });
        client.on("notification", onNotification);
      });
    } finally {
      await client.query("unlisten akp_outbox").catch(() => undefined);
      client.release();
    }
  }

  private async sleep(delayMs: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delayMs);
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}
