import {
  trace,
  type Attributes,
  type Context,
} from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import type {
  ReadableSpan,
  Span,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import type {
  CaptureOptions,
  RawTreeEventStatus,
} from "../monitoring.js";

export interface RawTreeOtelRegistrationOptions {
  forceRegisterProvider?: boolean;
  unregisterOnClose?: boolean;
}

export interface RawTreeTracerProviderRegistrationOptions extends RawTreeOtelRegistrationOptions {
  spanProcessors?: SpanProcessor[];
  resourceAttributes?: Attributes;
}

export interface RawTreeOtelProcessorRegistration {
  isEnabled: boolean;
  providerRegistered: boolean;
  teardown: () => Promise<void>;
}

export interface RawTreeTracerProviderRegistration {
  isEnabled: boolean;
  providerRegistered: boolean;
  created: boolean;
  forceFlush: () => Promise<void>;
  shutdown: () => Promise<void>;
}

export interface RawTreeOtelSpanSummaryOptions {
  captureResource?: boolean;
  captureScope?: boolean;
  captureEvents?: boolean;
  captureLinks?: boolean;
  attributes?: Record<string, unknown>;
}

let provider: NodeTracerProvider | undefined;
let providerCreatedByProcessorHost = false;
let shouldUnregisterProvider = true;

export function registerRawTreeSpanProcessor(
  processor: SpanProcessor,
  options: RawTreeOtelRegistrationOptions = {},
): RawTreeOtelProcessorRegistration {
  const registration = ensureRawTreeTracerProvider(options);

  if (!registration.providerRegistered) {
    return {
      isEnabled: false,
      providerRegistered: false,
      teardown: async () => {
        await processor.shutdown();
      },
    };
  }

  if (options.unregisterOnClose === false) {
    shouldUnregisterProvider = false;
  }

  processorHost.add(processor);

  let isTornDown = false;

  return {
    isEnabled: true,
    providerRegistered: registration.providerRegistered,
    teardown: async () => {
      if (isTornDown) {
        return;
      }

      isTornDown = true;
      processorHost.delete(processor);
      await processor.shutdown();

      if (
        processorHost.size === 0
        && providerCreatedByProcessorHost
        && provider
        && isActiveProvider(provider)
        && shouldUnregisterProvider
      ) {
        await shutdownRawTreeTracerProvider();
      }
    },
  };
}

export function registerRawTreeTracerProvider(
  options: RawTreeTracerProviderRegistrationOptions = {},
): RawTreeTracerProviderRegistration {
  const registration = ensureRawTreeTracerProvider(options, options.spanProcessors ?? []);

  return {
    isEnabled: registration.providerRegistered,
    providerRegistered: registration.providerRegistered,
    created: registration.created,
    forceFlush: async () => {
      await provider?.forceFlush();
    },
    shutdown: async () => {
      if (options.unregisterOnClose === false) {
        await provider?.forceFlush();
        return;
      }

      await shutdownRawTreeTracerProvider();
    },
  };
}

export async function shutdownRawTreeTracerProvider(): Promise<void> {
  if (!provider) {
    return;
  }

  const providerToShutdown = provider;
  provider = undefined;
  providerCreatedByProcessorHost = false;
  shouldUnregisterProvider = true;

  if (isActiveProvider(providerToShutdown)) {
    trace.disable();
  }

  await providerToShutdown.shutdown();
}

export function summarizeOtelSpan(
  span: ReadableSpan,
  options: RawTreeOtelSpanSummaryOptions = {},
): Record<string, unknown> {
  const status = summarizeOtelStatus(span.status);

  return compactRecord({
    name: span.name,
    kind: normalizeSpanKind(span.kind),
    status,
    statusMessage: typeof span.status.message === "string" ? span.status.message : undefined,
    startTimeUnixNano: hrTimeToUnixNano(span.startTime),
    endTimeUnixNano: hrTimeToUnixNano(span.endTime),
    attributes: options.attributes ?? attributesToRecord(span.attributes),
    resource: options.captureResource === false
      ? undefined
      : summarizeResource(span.resource),
    scope: options.captureScope === false
      ? undefined
      : summarizeScope(span.instrumentationScope),
    events: options.captureEvents ? summarizeSpanEvents(span.events) : undefined,
    links: options.captureLinks ? summarizeSpanLinks(span.links) : undefined,
    droppedAttributesCount: span.droppedAttributesCount,
    droppedEventsCount: span.droppedEventsCount,
    droppedLinksCount: span.droppedLinksCount,
  });
}

export function getOtelSpanCaptureOptions(span: ReadableSpan): CaptureOptions {
  const spanContext = span.spanContext();

  return {
    status: summarizeOtelStatus(span.status).rawtreeStatus,
    durationMs: hrTimeToMilliseconds(span.duration),
    traceId: spanContext.traceId,
    spanId: spanContext.spanId,
    parentSpanId: span.parentSpanContext?.spanId,
  };
}

export function summarizeOtelStatus(status: ReadableSpan["status"]): {
  rawtreeStatus: RawTreeEventStatus;
  code?: number;
  message?: string;
} {
  return {
    rawtreeStatus: status.code === 2 ? "error" : "ok",
    code: status.code,
    message: status.message,
  };
}

export function attributesToRecord(attributes: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const result = compactRecord(attributes ?? {});
  return Object.keys(result).length > 0 ? result : undefined;
}

export function compactRecord(record: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) {
      result[key] = normalizeValue(value);
    }
  }

  return result;
}

export function normalizeValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (Array.isArray(value)) {
    return value.map(normalizeValue);
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, normalizeValue(item)]),
    );
  }

  return String(value);
}

function ensureRawTreeTracerProvider(
  options: RawTreeTracerProviderRegistrationOptions,
  spanProcessors: SpanProcessor[] = [],
): { providerRegistered: boolean; created: boolean } {
  if (provider) {
    return {
      providerRegistered: isActiveProvider(provider),
      created: false,
    };
  }

  if (!options.forceRegisterProvider && hasExistingTracerProvider()) {
    return {
      providerRegistered: false,
      created: false,
    };
  }

  const nextProvider = new NodeTracerProvider({
    resource: options.resourceAttributes
      ? resourceFromAttributes(options.resourceAttributes)
      : undefined,
    spanProcessors: [...spanProcessors, processorHost],
  });

  nextProvider.register();
  provider = isActiveProvider(nextProvider) ? nextProvider : undefined;
  providerCreatedByProcessorHost = provider !== undefined && spanProcessors.length === 0;

  return {
    providerRegistered: provider !== undefined,
    created: provider !== undefined,
  };
}

function hasExistingTracerProvider(): boolean {
  return !isNoopTracerProvider(activeTracerProviderDelegate());
}

function isActiveProvider(candidate: NodeTracerProvider): boolean {
  return activeTracerProviderDelegate() === candidate;
}

function activeTracerProviderDelegate(): unknown {
  const tracerProvider = trace.getTracerProvider() as {
    getDelegate?: () => unknown;
  };

  return typeof tracerProvider.getDelegate === "function"
    ? tracerProvider.getDelegate()
    : tracerProvider;
}

function isNoopTracerProvider(candidate: unknown): boolean {
  return typeof candidate === "object"
    && candidate !== null
    && candidate.constructor?.name === "NoopTracerProvider";
}

function summarizeResource(resource: ReadableSpan["resource"]): Record<string, unknown> {
  return compactRecord({
    attributes: attributesToRecord(resource.attributes),
    schemaUrl: resource.schemaUrl,
    asyncAttributesPending: resource.asyncAttributesPending,
  });
}

function summarizeScope(scope: ReadableSpan["instrumentationScope"]): Record<string, unknown> {
  return compactRecord({
    name: scope.name,
    version: scope.version,
    schemaUrl: scope.schemaUrl,
  });
}

function summarizeSpanEvents(events: ReadableSpan["events"]): unknown[] | undefined {
  if (events.length === 0) {
    return undefined;
  }

  return events.map((event) => compactRecord({
    name: event.name,
    timeUnixNano: hrTimeToUnixNano(event.time),
    attributes: attributesToRecord(event.attributes),
    droppedAttributesCount: event.droppedAttributesCount,
  }));
}

function summarizeSpanLinks(links: ReadableSpan["links"]): unknown[] | undefined {
  if (links.length === 0) {
    return undefined;
  }

  return links.map((link) => compactRecord({
    traceId: link.context.traceId,
    spanId: link.context.spanId,
    traceState: link.context.traceState?.serialize(),
    attributes: attributesToRecord(link.attributes),
    droppedAttributesCount: link.droppedAttributesCount,
  }));
}

function normalizeSpanKind(kind: number): string | number {
  const kinds = ["internal", "server", "client", "producer", "consumer"];
  return kinds[kind] ?? kind;
}

function hrTimeToUnixNano(time: readonly [number, number]): string {
  return (BigInt(time[0]) * 1_000_000_000n + BigInt(time[1])).toString();
}

function hrTimeToMilliseconds(time: readonly [number, number]): number {
  return time[0] * 1_000 + time[1] / 1_000_000;
}

class MutableSpanProcessorHost implements SpanProcessor {
  private readonly processors = new Set<SpanProcessor>();

  get size(): number {
    return this.processors.size;
  }

  add(processor: SpanProcessor): void {
    this.processors.add(processor);
  }

  delete(processor: SpanProcessor): void {
    this.processors.delete(processor);
  }

  async forceFlush(): Promise<void> {
    await Promise.all([...this.processors].map((processor) => processor.forceFlush()));
  }

  onStart(span: Span, parentContext: Context): void {
    for (const processor of [...this.processors]) {
      processor.onStart(span, parentContext);
    }
  }

  onEnd(span: ReadableSpan): void {
    for (const processor of [...this.processors]) {
      processor.onEnd(span);
    }
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.processors].map((processor) => processor.shutdown()));
    this.processors.clear();
  }
}

const processorHost = new MutableSpanProcessorHost();
