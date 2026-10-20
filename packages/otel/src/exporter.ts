import { ExportResultCode } from "@opentelemetry/core";
import { JsonTraceSerializer } from "@opentelemetry/otlp-transformer";
import type {
  ReadableSpan,
  SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import {
  RawTree,
  RawTreeError,
  type JsonObject,
  type RawTreeOptions,
} from "@rawtree/sdk";
import { markExportErrorReported } from "./reported-export-errors.js";

export interface RawTreeTraceExporterOptions extends RawTreeOptions {
  table?: string;
  environment?: string;
  release?: string;
  /**
   * Called for every failed span export. When omitted, the exporter logs the
   * first failure (and any later failure with a different message) with
   * `console.error`.
   */
  onExportError?: (error: Error) => void;
}

const DEFAULT_TRACES_TABLE = "traces";
const OTLP_TRACES_TRANSFORM = "otlp-traces";

export class RawTreeTraceExporter implements SpanExporter {
  private readonly rawtree: RawTree;
  private readonly table: string;
  private readonly onExportError: (error: Error) => void;
  private exportChain: Promise<void> = Promise.resolve();
  private isShutdown = false;
  private lastLoggedExportError: string | undefined;

  constructor(options: RawTreeTraceExporterOptions) {
    const { onExportError, ...rawTreeOptions } = options;

    this.rawtree = new RawTree(rawTreeOptions);
    this.table = options.table ?? DEFAULT_TRACES_TABLE;
    this.onExportError = onExportError ?? ((error) => this.logExportError(error));
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
        const exportError = toError(error);

        this.reportExportError(exportError);
        resultCallback({
          code: ExportResultCode.FAILED,
          error: exportError,
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

  private reportExportError(error: Error): void {
    // Span processors may rethrow this error from forceFlush or shutdown.
    // Marking it lets registerOTel ignore failures that were already reported.
    markExportErrorReported(error);

    try {
      this.onExportError(error);
    } catch {
      // A throwing error handler must never break the host application.
    }
  }

  private logExportError(error: Error): void {
    const status = error instanceof RawTreeError ? ` (HTTP ${error.status})` : "";
    const message = `[rawtree] Failed to export spans to table "${this.table}"${status}: `
      + `${error.message}. Check your API key and database.`;

    if (message === this.lastLoggedExportError) {
      return;
    }

    this.lastLoggedExportError = message;
    console.error(message);
  }

  private async exportSpans(spans: ReadableSpan[]): Promise<void> {
    if (spans.length === 0) {
      return;
    }

    await this.rawtree.insert({
      table: this.table,
      values: toOtlpTraceExport(spans),
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
