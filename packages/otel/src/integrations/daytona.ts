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
  attributesToRecord,
  compactRecord,
  getOtelSpanCaptureOptions,
  registerRawTreeSpanProcessor,
  summarizeOtelSpan,
} from "./otel.js";

export interface RawTreeDaytonaIntegrationOptions {
  eventName?: string;
  captureAllSpans?: boolean;
  componentNames?: readonly string[];
  captureResource?: boolean;
  captureScope?: boolean;
  captureEvents?: boolean;
  captureLinks?: boolean;
  unregisterOnClose?: boolean;
  forceRegisterProvider?: boolean;
}

export interface RawTreeDaytonaIntegrationClient {
  isEnabled: boolean;
  providerRegistered: boolean;
  capturedComponents: readonly string[];
}

declare module "../monitoring.js" {
  interface RawTreeIntegrationRegistry {
    daytona: RawTreeDaytonaIntegrationClient;
  }
}

const DEFAULT_EVENT_NAME = "daytona.otel.span";
const DEFAULT_DAYTONA_COMPONENTS = [
  "Accessibility",
  "ComputerUse",
  "Daytona",
  "Display",
  "FileSystem",
  "Git",
  "Keyboard",
  "LspServer",
  "Mouse",
  "ObjectStorage",
  "Process",
  "PtyHandle",
  "RecordingService",
  "Sandbox",
  "Screenshot",
  "SnapshotService",
  "VolumeService",
] as const;

export function daytonaIntegration(
  options: RawTreeDaytonaIntegrationOptions = {},
): RawTreeIntegration {
  return {
    name: "daytona",
    setup(client) {
      const processor = new RawTreeDaytonaSpanProcessor(client, options);
      const registration = registerRawTreeSpanProcessor(processor, options);

      client.registerIntegrationUtility("daytona", {
        isEnabled: registration.isEnabled,
        providerRegistered: registration.providerRegistered,
        capturedComponents: processor.capturedComponents,
      } satisfies RawTreeIntegrationRegistry["daytona"]);

      return registration.teardown;
    },
  };
}

class RawTreeDaytonaSpanProcessor implements SpanProcessor {
  readonly capturedComponents: readonly string[];

  private readonly componentNames: Set<string>;
  private isShutdown = false;

  constructor(
    private readonly client: RawTreeMonitoringClient,
    private readonly options: RawTreeDaytonaIntegrationOptions,
  ) {
    this.capturedComponents = [
      ...(options.componentNames ?? DEFAULT_DAYTONA_COMPONENTS),
    ];
    this.componentNames = new Set(this.capturedComponents);
  }

  onStart(_span: Span): void {}

  onEnd(span: ReadableSpan): void {
    if (this.isShutdown || !this.shouldCapture(span)) {
      return;
    }

    this.client.capture(this.options.eventName ?? DEFAULT_EVENT_NAME, compactRecord({
      ...summarizeOtelSpan(span, {
        captureResource: this.options.captureResource,
        captureScope: this.options.captureScope,
        captureEvents: this.options.captureEvents,
        captureLinks: this.options.captureLinks,
        attributes: attributesToRecord(span.attributes),
      }),
    }), {
      source: "daytona",
      ...getOtelSpanCaptureOptions(span),
    });
  }

  async forceFlush(): Promise<void> {
    await this.client.flush();
  }

  async shutdown(): Promise<void> {
    this.isShutdown = true;
  }

  private shouldCapture(span: ReadableSpan): boolean {
    if (this.options.captureAllSpans) {
      return true;
    }

    const component = span.attributes.component;
    const method = span.attributes.method;

    return typeof component === "string"
      && typeof method === "string"
      && this.componentNames.has(component);
  }
}
