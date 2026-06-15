import { RawTree, type JsonObject, type JsonValue, type RawTreeOptions } from "@rawtree/sdk";

export type RawTreeEventLevel = "debug" | "info" | "warning" | "error" | "fatal";
export type RawTreeEventStatus = "ok" | "error";

export interface RawTreeEvent {
  id: string;
  timestamp: string;
  type: string;
  source: string;
  service?: string;
  environment?: string;
  release?: string;
  level?: RawTreeEventLevel;
  status?: RawTreeEventStatus;
  duration_ms?: number;
  trace_id?: string;
  span_id?: string;
  parent_span_id?: string;
  tags?: Record<string, string>;
  user?: Record<string, unknown>;
  context?: Record<string, unknown>;
  payload?: Record<string, unknown>;
  error?: RawTreeSerializedError;
}

export interface RawTreeSerializedError {
  name?: string;
  message: string;
  stack?: string;
  cause?: unknown;
}

export interface CaptureOptions {
  source?: string;
  level?: RawTreeEventLevel;
  status?: RawTreeEventStatus;
  durationMs?: number;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  error?: RawTreeSerializedError;
}

export interface RawTreeBatchOptions {
  size?: number;
  intervalMs?: number;
  maxQueueSize?: number;
}

export interface RedactionContext {
  path: string[];
}

export interface RawTreeIntegrationRegistry {}

export type RawTreeIntegrationTeardown = () => void | Promise<void>;

export interface RawTreeIntegration {
  name: string;
  setup: (
    client: RawTreeMonitoringClient,
  ) => void | RawTreeIntegrationTeardown | Promise<void | RawTreeIntegrationTeardown>;
}

export interface RawTreeMonitoringOptions extends RawTreeOptions {
  table?: string;
  service?: string;
  environment?: string;
  release?: string;
  integrations?: RawTreeIntegration[];
  enabled?: boolean;
  debug?: boolean;
  batch?: RawTreeBatchOptions;
  beforeSend?: (event: RawTreeEvent) => RawTreeEvent | null | Promise<RawTreeEvent | null>;
  redact?: (value: unknown, context: RedactionContext) => unknown;
}

const DEFAULT_TABLE = "events";
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_BATCH_INTERVAL_MS = 5_000;
const DEFAULT_MAX_QUEUE_SIZE = 1_000;

export class RawTreeMonitoringClient {
  readonly integrations: RawTreeIntegrationRegistry = {} as RawTreeIntegrationRegistry;

  private readonly rawtree: RawTree;
  private readonly table: string;
  private readonly service?: string;
  private readonly environment?: string;
  private readonly release?: string;
  private readonly enabled: boolean;
  private readonly debug: boolean;
  private readonly beforeSend?: RawTreeMonitoringOptions["beforeSend"];
  private readonly redact?: RawTreeMonitoringOptions["redact"];
  private readonly batch: Required<RawTreeBatchOptions>;
  private readonly eventQueue: JsonObject[] = [];
  private readonly pendingEventTasks = new Set<Promise<void>>();
  private readonly setupTasks: Promise<void>[] = [];
  private readonly teardowns: RawTreeIntegrationTeardown[] = [];

  private context: Record<string, unknown> = {};
  private tags: Record<string, string> = {};
  private user: Record<string, unknown> | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private flushChain: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(options: RawTreeMonitoringOptions) {
    this.rawtree = new RawTree(options);
    this.table = options.table ?? DEFAULT_TABLE;
    this.service = options.service;
    this.environment = options.environment;
    this.release = options.release;
    this.enabled = options.enabled ?? true;
    this.debug = options.debug ?? false;
    this.beforeSend = options.beforeSend;
    this.redact = options.redact;
    this.batch = {
      size: options.batch?.size ?? DEFAULT_BATCH_SIZE,
      intervalMs: options.batch?.intervalMs ?? DEFAULT_BATCH_INTERVAL_MS,
      maxQueueSize: options.batch?.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE,
    };

    for (const integration of options.integrations ?? []) {
      this.addIntegration(integration);
    }
  }

  capture(
    type: string,
    payload?: Record<string, unknown>,
    options: CaptureOptions = {},
  ): string | undefined {
    if (!this.enabled || this.closed) {
      return undefined;
    }

    const event = this.createEvent(type, payload, options);
    this.queueEvent(event);
    return event.id;
  }

  captureException(
    error: unknown,
    payload?: Record<string, unknown>,
    options: Omit<CaptureOptions, "error" | "level" | "status"> = {},
  ): string | undefined {
    return this.capture("exception", payload, {
      ...options,
      source: options.source ?? "manual",
      level: "error",
      status: "error",
      error: serializeError(error),
    });
  }

  async span<T>(
    name: string,
    fn: () => T | Promise<T>,
    payload?: Record<string, unknown>,
  ): Promise<T> {
    const startedAt = Date.now();

    try {
      const result = await fn();
      this.capture(name, payload, {
        source: "span",
        status: "ok",
        durationMs: Date.now() - startedAt,
      });
      return result;
    } catch (error) {
      this.captureException(error, { ...payload, span: name }, {
        source: "span",
        durationMs: Date.now() - startedAt,
      });
      throw error;
    }
  }

  addIntegration(integration: RawTreeIntegration): void {
    const setupTask = Promise.resolve(integration.setup(this))
      .then((teardown) => {
        if (typeof teardown === "function") {
          this.teardowns.push(teardown);
        }
      })
      .catch((error) => {
        this.debugLog(`RawTree integration "${integration.name}" failed to set up.`, error);
      });

    this.setupTasks.push(setupTask);
  }

  registerIntegrationUtility(name: string, utility: unknown): void {
    (this.integrations as unknown as Record<string, unknown>)[name] = utility;
  }

  setContext(context: Record<string, unknown>): void {
    this.context = { ...this.context, ...context };
  }

  setUser(user: Record<string, unknown> | null): void {
    this.user = user;
  }

  setTag(key: string, value: string): void {
    this.tags[key] = value;
  }

  async flush(timeoutMs?: number): Promise<void> {
    const operation = this.enqueueFlush();

    if (timeoutMs === undefined) {
      await operation;
      return;
    }

    await withTimeout(operation, timeoutMs);
  }

  async close(timeoutMs?: number): Promise<void> {
    this.closed = true;
    this.clearFlushTimer();
    await this.flush(timeoutMs);

    for (const teardown of this.teardowns.splice(0)) {
      await teardown();
    }
  }

  private createEvent(
    type: string,
    payload: Record<string, unknown> | undefined,
    options: CaptureOptions,
  ): RawTreeEvent {
    return {
      id: createId(),
      timestamp: new Date().toISOString(),
      type,
      source: options.source ?? "manual",
      service: this.service,
      environment: this.environment,
      release: this.release,
      level: options.level,
      status: options.status,
      duration_ms: options.durationMs,
      trace_id: options.traceId,
      span_id: options.spanId,
      parent_span_id: options.parentSpanId,
      tags: Object.keys(this.tags).length > 0 ? { ...this.tags } : undefined,
      user: this.user ? { ...this.user } : undefined,
      context: Object.keys(this.context).length > 0 ? { ...this.context } : undefined,
      payload,
      error: options.error,
    };
  }

  private queueEvent(event: RawTreeEvent): void {
    const task = this.prepareEvent(event);
    this.pendingEventTasks.add(task);
    void task.finally(() => this.pendingEventTasks.delete(task));
  }

  private async prepareEvent(event: RawTreeEvent): Promise<void> {
    try {
      const nextEvent = this.beforeSend ? await this.beforeSend(event) : event;

      if (nextEvent === null) {
        return;
      }

      if (this.eventQueue.length >= this.batch.maxQueueSize) {
        this.eventQueue.shift();
      }

      this.eventQueue.push(toJsonObject(nextEvent, this.redact));
      this.scheduleFlush(this.eventQueue.length >= this.batch.size ? 0 : this.batch.intervalMs);
    } catch (error) {
      this.debugLog("RawTree failed to prepare monitoring event.", error);
    }
  }

  private enqueueFlush(): Promise<void> {
    this.flushChain = this.flushChain.then(() => this.drainQueue());
    return this.flushChain;
  }

  private async drainQueue(): Promise<void> {
    this.clearFlushTimer();
    await Promise.all(this.setupTasks);
    await Promise.allSettled([...this.pendingEventTasks]);

    while (this.eventQueue.length > 0) {
      const rows = this.eventQueue.splice(0, this.batch.size);

      try {
        await this.rawtree.insert(this.table, rows);
      } catch (error) {
        this.eventQueue.unshift(...rows);
        throw error;
      }
    }
  }

  private scheduleFlush(delayMs: number): void {
    if (!this.enabled || this.closed) {
      return;
    }

    if (this.flushTimer !== undefined) {
      if (delayMs > 0) {
        return;
      }

      this.clearFlushTimer();
    }

    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flush().catch((error) => {
        this.debugLog("RawTree monitoring flush failed.", error);
      });
    }, delayMs);
  }

  private clearFlushTimer(): void {
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
  }

  private debugLog(message: string, error?: unknown): void {
    if (this.debug) {
      console.warn(message, error);
    }
  }
}

export function initRawTree(options: RawTreeMonitoringOptions): RawTreeMonitoringClient {
  return new RawTreeMonitoringClient(options);
}

export function serializeError(error: unknown): RawTreeSerializedError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      cause: "cause" in error ? error.cause : undefined,
    };
  }

  return {
    message: typeof error === "string"
      ? error
      : JSON.stringify(toJsonValue(error)) ?? String(error),
  };
}

function createId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `evt_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`RawTree flush timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function toJsonObject(
  value: unknown,
  redact?: RawTreeMonitoringOptions["redact"],
): JsonObject {
  const json = toJsonValue(value, redact, [], new WeakSet());

  if (json && typeof json === "object" && !Array.isArray(json)) {
    return json;
  }

  return {};
}

function toJsonValue(
  value: unknown,
  redact?: RawTreeMonitoringOptions["redact"],
  path: string[] = [],
  seen: WeakSet<object> = new WeakSet(),
): JsonValue | undefined {
  const redacted = redact ? redact(value, { path }) : value;

  if (redacted === undefined || typeof redacted === "function" || typeof redacted === "symbol") {
    return undefined;
  }

  if (redacted === null || typeof redacted === "string" || typeof redacted === "boolean") {
    return redacted;
  }

  if (typeof redacted === "number") {
    return Number.isFinite(redacted) ? redacted : null;
  }

  if (typeof redacted === "bigint") {
    return redacted.toString();
  }

  if (redacted instanceof Date) {
    return redacted.toISOString();
  }

  if (redacted instanceof Error) {
    return toJsonValue(serializeError(redacted), redact, path, seen);
  }

  if (redacted instanceof URL) {
    return redacted.toString();
  }

  if (redacted instanceof ArrayBuffer || ArrayBuffer.isView(redacted)) {
    return {
      type: "binary",
      byteLength: redacted.byteLength,
    };
  }

  if (Array.isArray(redacted)) {
    return redacted.map((item, index) => toJsonValue(
      item,
      redact,
      [...path, String(index)],
      seen,
    ) ?? null);
  }

  if (typeof redacted === "object") {
    if (seen.has(redacted)) {
      return "[Circular]";
    }

    seen.add(redacted);
    const json: JsonObject = {};

    for (const [key, item] of Object.entries(redacted)) {
      const nextValue = toJsonValue(item, redact, [...path, key], seen);

      if (nextValue !== undefined) {
        json[key] = nextValue;
      }
    }

    seen.delete(redacted);
    return json;
  }

  return String(redacted);
}
