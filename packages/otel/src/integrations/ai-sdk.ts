import { createRequire } from "node:module";
import { trace } from "@opentelemetry/api";
import type {
  ReadableSpan,
  Span,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
  type RawTreeIntegration,
  type RawTreeIntegrationRegistry,
  type RawTreeMonitoringClient,
} from "../monitoring.js";
import {
  getOtelSpanCaptureOptions,
  registerRawTreeSpanProcessor,
  summarizeOtelSpan,
} from "./otel.js";

export interface RawTreeAISDKIntegrationOptions {
  eventName?: string;
  captureResource?: boolean;
  captureScope?: boolean;
  captureEvents?: boolean;
  captureLinks?: boolean;
  unregisterOnClose?: boolean;
  forceRegisterProvider?: boolean;
  registerOpenTelemetry?: boolean;
}

export interface RawTreeAISDKIntegrationClient {
  isEnabled: boolean;
  providerRegistered: boolean;
  openTelemetryIntegrationAvailable: boolean;
  openTelemetryIntegrationRegistered: boolean;
  eventName: string;
}

declare module "../monitoring.js" {
  interface RawTreeIntegrationRegistry {
    aiSdk: RawTreeAISDKIntegrationClient;
  }
}

const DEFAULT_EVENT_NAME = "ai.sdk.otel.span";

const sdkRequire = createRequire(import.meta.url);

let aiSdkOtelRegistrationCount = 0;
let aiSdkOtelIntegration: unknown | undefined;

declare global {
  var AI_SDK_TELEMETRY_INTEGRATIONS: unknown[] | undefined;
}

interface AISDKOtelRegistration {
  isAvailable: boolean;
  isRegistered: boolean;
  teardown?: () => void;
}

interface AISDKOtelModule {
  OpenTelemetry?: new (options?: {
    tracer?: ReturnType<typeof trace.getTracer>;
  }) => unknown;
}

export function aiSdkIntegration(
  options: RawTreeAISDKIntegrationOptions = {},
): RawTreeIntegration {
  return {
    name: "ai-sdk",
    setup(client) {
      const processor = new RawTreeAISDKSpanProcessor(client, options);
      const registration = registerRawTreeSpanProcessor(processor, options);
      const aiSdkOtelRegistration = registration.isEnabled
        ? enableAISDKOpenTelemetry(options)
        : { isAvailable: false, isRegistered: false };

      client.registerIntegrationUtility("aiSdk", {
        isEnabled: registration.isEnabled,
        providerRegistered: registration.providerRegistered,
        openTelemetryIntegrationAvailable: aiSdkOtelRegistration.isAvailable,
        openTelemetryIntegrationRegistered: aiSdkOtelRegistration.isRegistered,
        eventName: getEventName(options),
      } satisfies RawTreeIntegrationRegistry["aiSdk"]);

      return async () => {
        aiSdkOtelRegistration.teardown?.();
        await registration.teardown();
      };
    },
    setupOtel() {
      const registration = enableAISDKOpenTelemetry(options);

      return () => {
        registration.teardown?.();
      };
    },
  };
}

class RawTreeAISDKSpanProcessor implements SpanProcessor {
  private isShutdown = false;

  constructor(
    private readonly client: RawTreeMonitoringClient,
    private readonly options: RawTreeAISDKIntegrationOptions,
  ) {}

  onStart(span: Span): void {
    void span;
  }

  onEnd(span: ReadableSpan): void {
    if (this.isShutdown) {
      return;
    }

    if (!isAISDKSpan(span)) {
      return;
    }

    this.client.capture(getEventName(this.options), summarizeOtelSpan(span, {
      captureResource: this.options.captureResource,
      captureScope: this.options.captureScope,
      captureEvents: this.options.captureEvents,
      captureLinks: this.options.captureLinks,
    }), {
      source: "ai-sdk",
      ...getOtelSpanCaptureOptions(span),
    });
  }

  async forceFlush(): Promise<void> {
    await this.client.flush();
  }

  async shutdown(): Promise<void> {
    this.isShutdown = true;
  }
}

function enableAISDKOpenTelemetry(
  options: RawTreeAISDKIntegrationOptions,
): AISDKOtelRegistration {
  if (options.registerOpenTelemetry === false) {
    return { isAvailable: false, isRegistered: false };
  }

  const otelModule = loadOptionalAISDKOtelModule();
  const OpenTelemetry = otelModule?.OpenTelemetry;

  if (!OpenTelemetry) {
    return { isAvailable: false, isRegistered: false };
  }

  if (!aiSdkOtelIntegration) {
    aiSdkOtelIntegration = new OpenTelemetry({
      tracer: trace.getTracer("gen_ai"),
    });
    globalThis.AI_SDK_TELEMETRY_INTEGRATIONS ??= [];
    globalThis.AI_SDK_TELEMETRY_INTEGRATIONS.push(aiSdkOtelIntegration);
  }

  aiSdkOtelRegistrationCount += 1;

  return {
    isAvailable: true,
    isRegistered: true,
    teardown: () => {
      aiSdkOtelRegistrationCount = Math.max(0, aiSdkOtelRegistrationCount - 1);

      if (aiSdkOtelRegistrationCount > 0 || !aiSdkOtelIntegration) {
        return;
      }

      const integrationToRemove = aiSdkOtelIntegration;
      globalThis.AI_SDK_TELEMETRY_INTEGRATIONS = globalThis.AI_SDK_TELEMETRY_INTEGRATIONS
        ?.filter((integration) => integration !== integrationToRemove);
      aiSdkOtelIntegration = undefined;
    },
  };
}

function loadOptionalAISDKOtelModule(): AISDKOtelModule | undefined {
  return requireOptionalAISDKOtel(sdkRequire)
    ?? requireOptionalAISDKOtel(createRequire(`${process.cwd()}/package.json`));
}

function requireOptionalAISDKOtel(requireFn: NodeRequire): AISDKOtelModule | undefined {
  try {
    return requireFn("@ai-sdk/otel") as AISDKOtelModule;
  } catch {
    return undefined;
  }
}

function isAISDKSpan(span: ReadableSpan): boolean {
  return span.name.startsWith("ai.")
    || typeof span.attributes["ai.operationId"] === "string"
    || typeof span.attributes["gen_ai.operation.name"] === "string";
}

function getEventName(options: RawTreeAISDKIntegrationOptions): string {
  return options.eventName ?? DEFAULT_EVENT_NAME;
}
