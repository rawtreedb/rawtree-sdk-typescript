import {
  BatchSpanProcessor,
  SimpleSpanProcessor,
  type BufferConfig,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import type { Attributes } from "@opentelemetry/api";
import {
  type RawTreeIntegration,
  type RawTreeIntegrationTeardown,
} from "./client.js";
import { RawTreeTraceExporter, type RawTreeTraceExporterOptions } from "./exporter.js";
import {
  registerRawTreeTracerProvider,
  shutdownRawTreeTracerProvider,
} from "./traces.js";

export interface RawTreeRegisterOtelBaseOptions {
  serviceName?: string;
  attributes?: Attributes;
  integrations?: RawTreeIntegration[];
  spanProcessor?: "batch" | "simple" | SpanProcessor;
  batchSpanProcessorOptions?: BufferConfig;
  forceRegisterProvider?: boolean;
  unregisterOnShutdown?: boolean;
}

export interface RawTreeRegisterOtelExporterOptions extends RawTreeRegisterOtelBaseOptions {
  exporter: RawTreeTraceExporter;
}

export interface RawTreeRegisterOtelRawTreeOptions
  extends RawTreeRegisterOtelBaseOptions,
    Omit<RawTreeTraceExporterOptions, "service" | "table" | "batch" | "attributes"> {
  exporter?: never;
}

export type RawTreeRegisterOtelOptions =
  | RawTreeRegisterOtelExporterOptions
  | RawTreeRegisterOtelRawTreeOptions;

export interface RawTreeOtelHandle {
  exporter: RawTreeTraceExporter;
  providerRegistered: boolean;
  shutdown: () => Promise<void>;
}

export function registerOTel(options: RawTreeRegisterOtelOptions): RawTreeOtelHandle {
  const exporterRegistration = toExporter(options);
  const exporter = exporterRegistration.exporter;
  const spanProcessorRegistration = toSpanProcessor(options, exporter);
  const spanProcessor = spanProcessorRegistration.spanProcessor;
  let providerRegistration: ReturnType<typeof registerRawTreeTracerProvider>;

  try {
    providerRegistration = registerRawTreeTracerProvider({
      forceRegisterProvider: options.forceRegisterProvider,
      resourceAttributes: getResourceAttributes(options),
      unregisterOnClose: options.unregisterOnShutdown,
      spanProcessors: [spanProcessor],
    });
  } catch (error) {
    cleanupUnusedTelemetryObjects(exporterRegistration, spanProcessorRegistration);
    throw error;
  }

  if (!providerRegistration.providerRegistered) {
    cleanupUnusedTelemetryObjects(exporterRegistration, spanProcessorRegistration);
    throw new Error(
      "RawTree could not register OpenTelemetry because another tracer provider is already active. "
        + "Use RawTreeTraceExporter with your existing OTel setup, or pass forceRegisterProvider: true.",
    );
  }

  if (!providerRegistration.created) {
    cleanupUnusedTelemetryObjects(exporterRegistration, spanProcessorRegistration);
    throw new Error(
      "RawTree OpenTelemetry is already registered in this process. "
        + "Call shutdown() before registering another RawTree OTel provider.",
    );
  }

  const integrationTeardowns: RawTreeIntegrationTeardown[] = [];

  try {
    for (const integration of options.integrations ?? []) {
      const setupResult = integration.setupOtel?.({ serviceName: options.serviceName });

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
    void shutdownRawTreeTracerProvider().catch(() => undefined);
    throw error;
  }

  let isShutdown = false;

  return {
    exporter,
    providerRegistered: providerRegistration.providerRegistered,
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

      try {
        await providerRegistration.shutdown();
      } catch (shutdownError) {
        if (teardownError) {
          throw new AggregateError(
            [teardownError, shutdownError],
            "RawTree OpenTelemetry shutdown failed.",
          );
        }

        throw shutdownError;
      }

      if (teardownError) {
        throw teardownError;
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

function getResourceAttributes(options: RawTreeRegisterOtelOptions): Attributes | undefined {
  const attributes = {
    ...options.attributes,
    "service.name": options.serviceName ?? options.attributes?.["service.name"],
  };
  const entries = Object.entries(attributes).filter(([, value]) => value !== undefined);

  return entries.length > 0
    ? Object.fromEntries(entries) as Attributes
    : undefined;
}

function hasCustomExporter(
  options: RawTreeRegisterOtelOptions,
): options is RawTreeRegisterOtelExporterOptions {
  return options.exporter instanceof RawTreeTraceExporter;
}

function toSpanProcessor(
  options: RawTreeRegisterOtelOptions,
  exporter: RawTreeTraceExporter,
): SpanProcessorRegistration {
  if (typeof options.spanProcessor === "object") {
    return {
      spanProcessor: options.spanProcessor,
      ownsSpanProcessor: false,
    };
  }

  if (options.spanProcessor === "simple") {
    return {
      spanProcessor: new SimpleSpanProcessor(exporter),
      ownsSpanProcessor: true,
    };
  }

  return {
    spanProcessor: new BatchSpanProcessor(exporter, options.batchSpanProcessorOptions),
    ownsSpanProcessor: true,
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
): void {
  if (spanProcessorRegistration.ownsSpanProcessor && exporterRegistration.ownsExporter) {
    void spanProcessorRegistration.spanProcessor.shutdown().catch(() => undefined);
    return;
  }

  if (exporterRegistration.ownsExporter) {
    void exporterRegistration.exporter.shutdown().catch(() => undefined);
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
