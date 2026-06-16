import {
  MetricReader,
  PeriodicExportingMetricReader,
  type PeriodicExportingMetricReaderOptions,
  type PushMetricExporter,
  type ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import {
  BatchSpanProcessor,
  SimpleSpanProcessor,
  type BufferConfig,
  type ReadableSpan,
  type SpanExporter,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import type { Attributes } from "@opentelemetry/api";
import {
  type RawTreeIntegration,
  type RawTreeIntegrationTeardown,
  type RawTreeOtelIntegrationContext,
} from "./client.js";
import {
  RawTreeMetricExporter,
  RawTreeTraceExporter,
} from "./exporter.js";
import {
  registerRawTreeMeterProvider,
  shutdownRawTreeMeterProvider,
} from "./metrics.js";
import {
  registerRawTreeTracerProvider,
  shutdownRawTreeTracerProvider,
} from "./traces.js";

export interface RawTreeRegisterOtelBaseOptions {
  serviceName?: string;
  environment?: string;
  release?: string;
  attributes?: Attributes;
  integrations?: RawTreeIntegration[];
  spanProcessor?: "batch" | "simple" | SpanProcessor;
  batchSpanProcessorOptions?: BufferConfig;
  metrics?: boolean;
  metricExporter?: RawTreeMetricExporter;
  metricReader?: "periodic" | MetricReader;
  metricReaderOptions?: Omit<PeriodicExportingMetricReaderOptions, "exporter">;
  forceRegisterProvider?: boolean;
  unregisterOnShutdown?: boolean;
}

export interface RawTreeRegisterOtelExporterOptions extends RawTreeRegisterOtelBaseOptions {
  exporter: RawTreeTraceExporter;
}

export interface RawTreeRegisterOtelRawTreeOptions
  extends RawTreeRegisterOtelBaseOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  exporter?: never;
}

export type RawTreeRegisterOtelOptions =
  | RawTreeRegisterOtelExporterOptions
  | RawTreeRegisterOtelRawTreeOptions;

export interface RawTreeOtelHandle {
  exporter: RawTreeTraceExporter;
  metricExporter?: RawTreeMetricExporter;
  providerRegistered: boolean;
  meterProviderRegistered: boolean;
  shutdown: () => Promise<void>;
}

export function registerOTel(options: RawTreeRegisterOtelOptions): RawTreeOtelHandle {
  const exporterRegistration = toExporter(options);
  const exporter = exporterRegistration.exporter;
  const spanProcessorRegistration = toSpanProcessor(options, exporterRegistration);
  const spanProcessor = spanProcessorRegistration.spanProcessor;
  const metricExporterRegistration = toMetricExporter(options);
  const metricReaderRegistration = toMetricReader(options, metricExporterRegistration);
  const metricReader = metricReaderRegistration.metricReader;
  let providerRegistration: ReturnType<typeof registerRawTreeTracerProvider>;
  let meterProviderRegistration: ReturnType<typeof registerRawTreeMeterProvider> | undefined;

  try {
    providerRegistration = registerRawTreeTracerProvider({
      forceRegisterProvider: options.forceRegisterProvider,
      resourceAttributes: getResourceAttributes(options),
      unregisterOnClose: options.unregisterOnShutdown,
      spanProcessors: [spanProcessor],
    });
  } catch (error) {
    cleanupUnusedTelemetryObjects(
      exporterRegistration,
      spanProcessorRegistration,
      metricExporterRegistration,
      metricReaderRegistration,
    );
    throw error;
  }

  if (!providerRegistration.providerRegistered) {
    cleanupUnusedTelemetryObjects(
      exporterRegistration,
      spanProcessorRegistration,
      metricExporterRegistration,
      metricReaderRegistration,
    );
    throw new Error(
      "RawTree could not register OpenTelemetry because another tracer provider is already active. "
        + "Use RawTreeTraceExporter with your existing OTel setup, or pass forceRegisterProvider: true.",
    );
  }

  if (!providerRegistration.created) {
    cleanupUnusedTelemetryObjects(
      exporterRegistration,
      spanProcessorRegistration,
      metricExporterRegistration,
      metricReaderRegistration,
    );
    throw new Error(
      "RawTree OpenTelemetry is already registered in this process. "
        + "Call shutdown() before registering another RawTree OTel provider.",
    );
  }

  if (metricReader) {
    try {
      meterProviderRegistration = registerRawTreeMeterProvider({
        forceRegisterProvider: options.forceRegisterProvider,
        resourceAttributes: getResourceAttributes(options),
        unregisterOnClose: options.unregisterOnShutdown,
        metricReaders: [metricReader],
      });
    } catch (error) {
      cleanupUnusedMetricTelemetryObjects(metricExporterRegistration, metricReaderRegistration);
      void shutdownRawTreeTracerProvider().catch(() => undefined);
      throw error;
    }

    if (!meterProviderRegistration.providerRegistered) {
      cleanupUnusedMetricTelemetryObjects(metricExporterRegistration, metricReaderRegistration);
      void shutdownRawTreeTracerProvider().catch(() => undefined);
      throw new Error(
        "RawTree could not register OpenTelemetry metrics because another meter provider is already active. "
          + "Use RawTreeMetricExporter with your existing OTel setup, pass metrics: false, "
          + "or pass forceRegisterProvider: true.",
      );
    }

    if (!meterProviderRegistration.created) {
      cleanupUnusedMetricTelemetryObjects(metricExporterRegistration, metricReaderRegistration);
      void shutdownRawTreeTracerProvider().catch(() => undefined);
      throw new Error(
        "RawTree OpenTelemetry metrics are already registered in this process. "
          + "Call shutdown() before registering another RawTree OTel provider.",
      );
    }
  }

  const integrationTeardowns: RawTreeIntegrationTeardown[] = [];
  const integrationContext = getIntegrationContext(options);

  try {
    for (const integration of options.integrations ?? []) {
      const setupResult = integration.setupOtel?.(integrationContext);

      if (isPromiseLike(setupResult)) {
        void Promise.resolve(setupResult).catch(() => undefined);
        throw new Error(
          `RawTree integration "${integration.name}" returned an async setupOtel result. `
            + "OpenTelemetry integrations must set up synchronously.",
        );
      } else if (typeof setupResult === "function") {
        integrationTeardowns.push(setupResult);
      }
    }
  } catch (error) {
    cleanupIntegrationTeardowns(integrationTeardowns);
    void shutdownRawTreeMeterProvider().catch(() => undefined);
    void shutdownRawTreeTracerProvider().catch(() => undefined);
    throw error;
  }

  let isShutdown = false;

  return {
    exporter,
    metricExporter: metricExporterRegistration.metricExporter,
    providerRegistered: providerRegistration.providerRegistered,
    meterProviderRegistered: meterProviderRegistration?.providerRegistered ?? false,
    shutdown: async () => {
      if (isShutdown) {
        return;
      }

      isShutdown = true;

      let teardownError: unknown;

      try {
        await runIntegrationTeardowns(integrationTeardowns);
      } catch (error) {
        teardownError = error;
      }

      const shutdownErrors: unknown[] = [];

      if (teardownError) {
        shutdownErrors.push(teardownError);
      }

      try {
        await meterProviderRegistration?.shutdown();
      } catch (shutdownError) {
        shutdownErrors.push(shutdownError);
      }

      try {
        await providerRegistration.shutdown();
      } catch (shutdownError) {
        shutdownErrors.push(shutdownError);
      }

      if (shutdownErrors.length === 1) {
        throw shutdownErrors[0];
      }

      if (shutdownErrors.length > 1) {
        throw new AggregateError(
          shutdownErrors,
          "RawTree OpenTelemetry shutdown failed.",
        );
      }
    },
  };
}

interface ExporterRegistration {
  exporter: RawTreeTraceExporter;
  ownsExporter: boolean;
}

interface SpanProcessorRegistration {
  spanProcessor: SpanProcessor;
  ownsSpanProcessor: boolean;
}

interface MetricExporterRegistration {
  metricExporter?: RawTreeMetricExporter;
  ownsMetricExporter: boolean;
}

interface MetricReaderRegistration {
  metricReader?: MetricReader;
  ownsMetricReader: boolean;
}

function toExporter(options: RawTreeRegisterOtelOptions): ExporterRegistration {
  if (hasCustomExporter(options)) {
    return {
      exporter: options.exporter,
      ownsExporter: false,
    };
  }

  const {
    serviceName,
    attributes: _attributes,
    exporter: _exporter,
    integrations: _integrations,
    spanProcessor: _spanProcessor,
    batchSpanProcessorOptions: _batchSpanProcessorOptions,
    metrics: _metrics,
    metricExporter: _metricExporter,
    metricReader: _metricReader,
    metricReaderOptions: _metricReaderOptions,
    forceRegisterProvider: _forceRegisterProvider,
    unregisterOnShutdown: _unregisterOnShutdown,
    ...exporterOptions
  } = options;

  return {
    exporter: new RawTreeTraceExporter({
      ...exporterOptions,
    }),
    ownsExporter: true,
  };
}

function toMetricExporter(options: RawTreeRegisterOtelOptions): MetricExporterRegistration {
  if (options.metrics === false) {
    return {
      ownsMetricExporter: false,
    };
  }

  if (options.metricExporter) {
    return {
      metricExporter: options.metricExporter,
      ownsMetricExporter: false,
    };
  }

  if (hasCustomExporter(options)) {
    return {
      ownsMetricExporter: false,
    };
  }

  return {
    metricExporter: new RawTreeMetricExporter({
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      fetch: options.fetch,
    }),
    ownsMetricExporter: true,
  };
}

function getResourceAttributes(options: RawTreeRegisterOtelOptions): Attributes | undefined {
  const attributes = {
    ...options.attributes,
    "service.name": options.serviceName ?? options.attributes?.["service.name"],
    "deployment.environment.name": options.environment
      ?? options.attributes?.["deployment.environment.name"],
    "service.version": options.release ?? options.attributes?.["service.version"],
  };
  const entries = Object.entries(attributes).filter(([, value]) => value !== undefined);

  return entries.length > 0
    ? Object.fromEntries(entries) as Attributes
    : undefined;
}

function getIntegrationContext(
  options: RawTreeRegisterOtelOptions,
): RawTreeOtelIntegrationContext {
  const rawTreeOptions = hasCustomExporter(options) ? undefined : options;

  return {
    apiKey: rawTreeOptions?.apiKey,
    baseUrl: rawTreeOptions?.baseUrl,
    serviceName: options.serviceName,
    environment: options.environment,
    release: options.release,
  };
}

function hasCustomExporter(
  options: RawTreeRegisterOtelOptions,
): options is RawTreeRegisterOtelExporterOptions {
  return options.exporter instanceof RawTreeTraceExporter;
}

function toSpanProcessor(
  options: RawTreeRegisterOtelOptions,
  exporterRegistration: ExporterRegistration,
): SpanProcessorRegistration {
  if (typeof options.spanProcessor === "object") {
    return {
      spanProcessor: options.spanProcessor,
      ownsSpanProcessor: false,
    };
  }

  const spanExporter = exporterRegistration.ownsExporter
    ? exporterRegistration.exporter
    : new NonClosingSpanExporter(exporterRegistration.exporter);

  if (options.spanProcessor === "simple") {
    return {
      spanProcessor: new SimpleSpanProcessor(spanExporter),
      ownsSpanProcessor: true,
    };
  }

  return {
    spanProcessor: new BatchSpanProcessor(spanExporter, options.batchSpanProcessorOptions),
    ownsSpanProcessor: true,
  };
}

function toMetricReader(
  options: RawTreeRegisterOtelOptions,
  metricExporterRegistration: MetricExporterRegistration,
): MetricReaderRegistration {
  if (!metricExporterRegistration.metricExporter) {
    return {
      ownsMetricReader: false,
    };
  }

  if (typeof options.metricReader === "object") {
    return {
      metricReader: options.metricReader,
      ownsMetricReader: false,
    };
  }

  const exporter = metricExporterRegistration.ownsMetricExporter
    ? metricExporterRegistration.metricExporter
    : new NonClosingMetricExporter(metricExporterRegistration.metricExporter);

  return {
    metricReader: new PeriodicExportingMetricReader({
      ...options.metricReaderOptions,
      exporter,
    }),
    ownsMetricReader: true,
  };
}

function isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return typeof value === "object"
    && value !== null
    && "then" in value
    && typeof value.then === "function";
}

function cleanupUnusedTelemetryObjects(
  exporterRegistration: ExporterRegistration,
  spanProcessorRegistration: SpanProcessorRegistration,
  metricExporterRegistration: MetricExporterRegistration,
  metricReaderRegistration: MetricReaderRegistration,
): void {
  if (spanProcessorRegistration.ownsSpanProcessor) {
    void spanProcessorRegistration.spanProcessor.shutdown().catch(() => undefined);
  } else if (exporterRegistration.ownsExporter) {
    void exporterRegistration.exporter.shutdown().catch(() => undefined);
  }

  cleanupUnusedMetricTelemetryObjects(metricExporterRegistration, metricReaderRegistration);
}

function cleanupUnusedMetricTelemetryObjects(
  metricExporterRegistration: MetricExporterRegistration,
  metricReaderRegistration: MetricReaderRegistration,
): void {
  if (metricReaderRegistration.ownsMetricReader && metricReaderRegistration.metricReader) {
    void metricReaderRegistration.metricReader.shutdown().catch(() => undefined);
    return;
  }

  if (
    metricExporterRegistration.ownsMetricExporter
    && metricExporterRegistration.metricExporter
  ) {
    void metricExporterRegistration.metricExporter.shutdown().catch(() => undefined);
  }
}

class NonClosingSpanExporter implements SpanExporter {
  constructor(private readonly exporter: RawTreeTraceExporter) {}

  export(
    spans: ReadableSpan[],
    resultCallback: Parameters<SpanExporter["export"]>[1],
  ): void {
    this.exporter.export(spans, resultCallback);
  }

  async forceFlush(): Promise<void> {
    await this.exporter.forceFlush();
  }

  async shutdown(): Promise<void> {
    await this.exporter.forceFlush();
  }
}

class NonClosingMetricExporter implements PushMetricExporter {
  constructor(private readonly exporter: RawTreeMetricExporter) {}

  export(
    metrics: ResourceMetrics,
    resultCallback: Parameters<PushMetricExporter["export"]>[1],
  ): void {
    this.exporter.export(metrics, resultCallback);
  }

  async forceFlush(): Promise<void> {
    await this.exporter.forceFlush();
  }

  selectAggregationTemporality(
    instrumentType: Parameters<NonNullable<PushMetricExporter["selectAggregationTemporality"]>>[0],
  ): ReturnType<NonNullable<PushMetricExporter["selectAggregationTemporality"]>> {
    return this.exporter.selectAggregationTemporality(instrumentType);
  }

  async shutdown(): Promise<void> {
    await this.exporter.forceFlush();
  }
}

function cleanupIntegrationTeardowns(teardowns: RawTreeIntegrationTeardown[]): void {
  for (const teardown of teardowns.splice(0)) {
    void Promise.resolve(teardown()).catch(() => undefined);
  }
}

async function runIntegrationTeardowns(
  teardowns: RawTreeIntegrationTeardown[],
): Promise<void> {
  const errors: unknown[] = [];

  for (const teardown of teardowns.splice(0)) {
    try {
      await teardown();
    } catch (error) {
      errors.push(error);
    }
  }

  if (errors.length === 1) {
    throw errors[0];
  }

  if (errors.length > 1) {
    throw new AggregateError(errors, "RawTree OpenTelemetry integration teardowns failed.");
  }
}
