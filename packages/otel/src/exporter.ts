import { ExportResultCode } from "@opentelemetry/core";
import { JsonTraceSerializer } from "@opentelemetry/otlp-transformer";
import type {
  ReadableSpan,
  SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import {
  RawTree,
  type JsonObject,
  type RawTreeOptions,
} from "@rawtree/sdk";

export interface RawTreeTraceExporterOptions extends RawTreeOptions {
  table?: string;
  environment?: string;
  release?: string;
}

const DEFAULT_TRACES_TABLE = "traces";
const OTLP_TRACES_TRANSFORM = "otlp-traces";

export class RawTreeTraceExporter implements SpanExporter {
  private readonly rawtree: RawTree;
  private readonly table: string;
  private exportChain: Promise<void> = Promise.resolve();
  private isShutdown = false;

  constructor(options: RawTreeTraceExporterOptions) {
    this.rawtree = new RawTree(options);
    this.table = options.table ?? DEFAULT_TRACES_TABLE;
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
  }

  async shutdown(): Promise<void> {
    if (this.isShutdown) {
      return;
    }

    this.isShutdown = true;
    await this.forceFlush();
  }

  private async exportSpans(spans: ReadableSpan[]): Promise<void> {
    if (spans.length === 0) {
      return;
    }

    await this.rawtree.insert(this.table, toOtlpTraceExport(spans), {
      transform: OTLP_TRACES_TRANSFORM,
    });
  }
}

function toOtlpTraceExport(spans: ReadableSpan[]): JsonObject {
  const serializedRequest = JsonTraceSerializer.serializeRequest(spans);

  if (!serializedRequest) {
    return { resourceSpans: [] };
  }

  return JSON.parse(new TextDecoder().decode(serializedRequest)) as JsonObject;
}

function toError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error(typeof error === "string" ? error : JSON.stringify(error));
}
