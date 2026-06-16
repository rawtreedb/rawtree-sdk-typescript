import { ExportResultCode } from "@opentelemetry/core";
import type {
  ReadableSpan,
  SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import {
  RawTreeMonitoringClient,
  type RawTreeMonitoringOptions,
} from "./client.js";
import {
  getOtelSpanCaptureOptions,
  summarizeOtelSpan,
  type RawTreeOtelSpanSummaryOptions,
} from "./traces.js";

export interface RawTreeTraceExporterOptions
  extends Omit<RawTreeMonitoringOptions, "integrations">,
    RawTreeOtelSpanSummaryOptions {
  eventName?: string;
  source?: string;
}

const DEFAULT_EVENT_NAME = "otel.span";
const DEFAULT_SOURCE = "otel";
const DEFAULT_TRACES_TABLE = "traces";

export class RawTreeTraceExporter implements SpanExporter {
  private readonly client: RawTreeMonitoringClient;
  private readonly eventName: string;
  private readonly source: string;
  private readonly summaryOptions: RawTreeOtelSpanSummaryOptions;
  private exportChain: Promise<void> = Promise.resolve();
  private isShutdown = false;

  constructor(options: RawTreeTraceExporterOptions) {
    this.client = new RawTreeMonitoringClient({
      ...options,
      table: options.table ?? DEFAULT_TRACES_TABLE,
      integrations: [],
    });
    this.eventName = options.eventName ?? DEFAULT_EVENT_NAME;
    this.source = options.source ?? DEFAULT_SOURCE;
    this.summaryOptions = {
      captureResource: options.captureResource,
      captureScope: options.captureScope,
      captureEvents: options.captureEvents,
      captureLinks: options.captureLinks,
      attributes: options.attributes,
    };
  }

  export(
    spans: ReadableSpan[],
    resultCallback: (result: { code: ExportResultCode; error?: Error }) => void,
  ): void {
    if (this.isShutdown) {
      resultCallback({
        code: ExportResultCode.FAILED,
        error: new Error("RawTreeTraceExporter is already shut down."),
      });
      return;
    }

    const exportTask = this.exportChain
      .catch(() => undefined)
      .then(() => this.exportSpans(spans));

    this.exportChain = exportTask.catch(() => undefined);

    void exportTask.then(
      () => {
        resultCallback({ code: ExportResultCode.SUCCESS });
      },
      (error) => {
        resultCallback({
          code: ExportResultCode.FAILED,
          error: toError(error),
        });
      },
    );
  }

  async forceFlush(): Promise<void> {
    await this.exportChain;
    await this.client.flush();
  }

  async shutdown(): Promise<void> {
    if (this.isShutdown) {
      return;
    }

    this.isShutdown = true;
    await this.forceFlush();
    await this.client.close();
  }

  private async exportSpans(spans: ReadableSpan[]): Promise<void> {
    for (const span of spans) {
      this.client.capture(this.eventName, summarizeOtelSpan(span, this.summaryOptions), {
        source: this.source,
        ...getOtelSpanCaptureOptions(span),
      });
    }

    await this.client.flush();
  }
}

function toError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error(typeof error === "string" ? error : JSON.stringify(error));
}
