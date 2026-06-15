import {
  BatchSpanProcessor,
  SimpleSpanProcessor,
  type BufferConfig,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
  type RawTreeIntegration,
  type RawTreeIntegrationTeardown,
} from "./monitoring.js";
import { RawTreeTraceExporter, type RawTreeTraceExporterOptions } from "./exporter.js";
import { registerRawTreeTracerProvider } from "./integrations/otel.js";

export interface RawTreeRegisterOtelOptions {
  serviceName?: string;
  rawtree: RawTreeTraceExporterOptions | RawTreeTraceExporter;
  integrations?: RawTreeIntegration[];
  spanProcessor?: "batch" | "simple" | SpanProcessor;
  batch?: BufferConfig;
  forceRegisterProvider?: boolean;
  unregisterOnShutdown?: boolean;
}

export interface RawTreeOtelHandle {
  exporter: RawTreeTraceExporter;
  providerRegistered: boolean;
  shutdown: () => Promise<void>;
}

export function registerOTel(options: RawTreeRegisterOtelOptions): RawTreeOtelHandle {
  const exporter = toExporter(options);
  const spanProcessor = toSpanProcessor(options, exporter);
  const providerRegistration = registerRawTreeTracerProvider({
    forceRegisterProvider: options.forceRegisterProvider,
    unregisterOnClose: options.unregisterOnShutdown,
    spanProcessors: [spanProcessor],
  });

  if (!providerRegistration.providerRegistered) {
    throw new Error(
      "RawTree could not register OpenTelemetry because another tracer provider is already active. "
        + "Use RawTreeTraceExporter with your existing OTel setup, or pass forceRegisterProvider: true.",
    );
  }

  if (!providerRegistration.created) {
    throw new Error(
      "RawTree OpenTelemetry is already registered in this process. "
        + "Call shutdown() before registering another RawTree OTel provider.",
    );
  }

  const integrationTeardowns: RawTreeIntegrationTeardown[] = [];
  const integrationSetupTasks: Promise<void>[] = [];
  const integrationSetupErrors: unknown[] = [];

  try {
    for (const integration of options.integrations ?? []) {
      const setupResult = integration.setupOtel?.({ serviceName: options.serviceName });

      if (isPromiseLike(setupResult)) {
        integrationSetupTasks.push(
          Promise.resolve(setupResult)
            .then((teardown) => {
              if (typeof teardown === "function") {
                integrationTeardowns.push(teardown);
              }
            })
            .catch((error) => {
              integrationSetupErrors.push(error);
            }),
        );
      } else if (typeof setupResult === "function") {
        integrationTeardowns.push(setupResult);
      }
    }
  } catch (error) {
    void providerRegistration.shutdown();
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
      await Promise.all(integrationSetupTasks);

      for (const teardown of integrationTeardowns.splice(0)) {
        await teardown();
      }

      await providerRegistration.shutdown();

      if (integrationSetupErrors.length > 0) {
        throw toError(integrationSetupErrors[0]);
      }
    },
  };
}

function toExporter(options: RawTreeRegisterOtelOptions): RawTreeTraceExporter {
  if (options.rawtree instanceof RawTreeTraceExporter) {
    return options.rawtree;
  }

  return new RawTreeTraceExporter({
    ...options.rawtree,
    service: options.rawtree.service ?? options.serviceName,
  });
}

function toSpanProcessor(
  options: RawTreeRegisterOtelOptions,
  exporter: RawTreeTraceExporter,
): SpanProcessor {
  if (typeof options.spanProcessor === "object") {
    return options.spanProcessor;
  }

  if (options.spanProcessor === "simple") {
    return new SimpleSpanProcessor(exporter);
  }

  return new BatchSpanProcessor(exporter, options.batch);
}

function isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return typeof value === "object"
    && value !== null
    && "then" in value
    && typeof value.then === "function";
}

function toError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error(typeof error === "string" ? error : JSON.stringify(error));
}
