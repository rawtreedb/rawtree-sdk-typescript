// Internal bookkeeping shared by the exporter and registerOTel. Not exported
// from the package entry points.
const reportedExportErrors = new WeakSet<Error>();

export function markExportErrorReported(error: Error): void {
  reportedExportErrors.add(error);
}

export function isReportedExportError(error: unknown): boolean {
  return error instanceof Error && reportedExportErrors.has(error);
}
