import type {
  RawTreeIntegration,
  RawTreeOtelIntegrationContext,
} from "../client.js";

export interface RawTreeDaytonaIntegrationOptions {
  apiKey?: string;
  baseUrl?: string;
  tracesEndpoint?: string;
  metricsEndpoint?: string;
  tracesTable?: string;
  metricsTable?: string;
  headers?: Record<string, string>;
}

export interface RawTreeDaytonaOtelConfiguration {
  tracesEndpoint: string;
  metricsEndpoint: string;
  headers: string;
  tracesTable?: string;
  metricsTable?: string;
  shutdown: () => void;
}

const DEFAULT_RAWTREE_BASE_URL = "https://api.rawtree.com";
const OTLP_TRACES_PATH = "/otlp/v1/traces";
const OTLP_METRICS_PATH = "/otlp/v1/metrics";
const OTLP_PROTOCOL = "http/protobuf";
const OTEL_EXPORTER_OTLP_PROTOCOL = "OTEL_EXPORTER_OTLP_PROTOCOL";
const OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT";
const OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT";
const OTEL_EXPORTER_OTLP_HEADERS = "OTEL_EXPORTER_OTLP_HEADERS";

const DAYTONA_OTEL_ENV_KEYS = [
  OTEL_EXPORTER_OTLP_PROTOCOL,
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
  OTEL_EXPORTER_OTLP_METRICS_ENDPOINT,
  OTEL_EXPORTER_OTLP_HEADERS,
] as const;

export function daytonaIntegration(
  options: RawTreeDaytonaIntegrationOptions = {},
): RawTreeIntegration {
  return {
    name: "daytona",
    setupOtel(context) {
      const configuration = configureDaytonaOtel(options, context);

      return configuration.shutdown;
    },
  };
}

export function configureDaytonaOtel(
  options: RawTreeDaytonaIntegrationOptions = {},
  context: RawTreeOtelIntegrationContext = {},
): RawTreeDaytonaOtelConfiguration {
  const apiKey = options.apiKey ?? context.apiKey ?? process.env.RAWTREE_API_KEY;

  if (!apiKey) {
    throw new Error(
      "RawTree Daytona integration requires an apiKey. "
        + "Pass apiKey to daytonaIntegration(), use registerOTel({ apiKey, integrations }), "
        + "or set RAWTREE_API_KEY.",
    );
  }

  const previousEnvironment = snapshotEnvironment(DAYTONA_OTEL_ENV_KEYS);
  const tracesEndpoint = getTracesEndpoint(options, context);
  const metricsEndpoint = getMetricsEndpoint(options, context);
  const headers = getOtlpHeaders({
    apiKey,
    tracesTable: options.tracesTable,
    metricsTable: options.metricsTable,
    headers: options.headers,
  });

  process.env[OTEL_EXPORTER_OTLP_PROTOCOL] = OTLP_PROTOCOL;
  process.env[OTEL_EXPORTER_OTLP_TRACES_ENDPOINT] = tracesEndpoint;
  process.env[OTEL_EXPORTER_OTLP_METRICS_ENDPOINT] = metricsEndpoint;
  process.env[OTEL_EXPORTER_OTLP_HEADERS] = headers;

  return {
    tracesEndpoint,
    metricsEndpoint,
    headers,
    tracesTable: options.tracesTable,
    metricsTable: options.metricsTable,
    shutdown: () => {
      restoreEnvironment(previousEnvironment);
    },
  };
}

interface OtlpHeaderOptions {
  apiKey: string;
  tracesTable?: string;
  metricsTable?: string;
  headers?: Record<string, string>;
}

interface HeaderEntry {
  key: string;
  value: string;
}

function getTracesEndpoint(
  options: RawTreeDaytonaIntegrationOptions,
  context: RawTreeOtelIntegrationContext,
): string {
  if (options.tracesEndpoint) {
    return trimTrailingSlashes(options.tracesEndpoint);
  }

  return `${getRawTreeOtlpBaseUrl(options.baseUrl ?? context.baseUrl)}${OTLP_TRACES_PATH}`;
}

function getMetricsEndpoint(
  options: RawTreeDaytonaIntegrationOptions,
  context: RawTreeOtelIntegrationContext,
): string {
  if (options.metricsEndpoint) {
    return trimTrailingSlashes(options.metricsEndpoint);
  }

  if (options.tracesEndpoint) {
    return getSiblingSignalEndpoint(options.tracesEndpoint, "metrics");
  }

  return `${getRawTreeOtlpBaseUrl(options.baseUrl ?? context.baseUrl)}${OTLP_METRICS_PATH}`;
}

function getRawTreeOtlpBaseUrl(baseUrl = DEFAULT_RAWTREE_BASE_URL): string {
  return trimTrailingSlashes(baseUrl).replace(/\/v1$/, "");
}

function getOtlpHeaders(options: OtlpHeaderOptions): string {
  const entries = parseOtlpHeaders(process.env[OTEL_EXPORTER_OTLP_HEADERS]);

  for (const [key, value] of Object.entries(options.headers ?? {})) {
    setOtlpHeader(entries, key, value);
  }

  setOtlpHeader(entries, "authorization", `Bearer ${options.apiKey}`);

  if (options.tracesTable) {
    setOtlpHeader(entries, "x-rawtree-traces-table", options.tracesTable);
  }

  if (options.metricsTable) {
    setOtlpHeader(entries, "x-rawtree-metrics-table", options.metricsTable);
  }

  return entries.map(({ key, value }) => `${key}=${value}`).join(",");
}

function parseOtlpHeaders(value: string | undefined): HeaderEntry[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((header) => header.trim())
    .filter((header) => header.length > 0)
    .map((header) => {
      const separatorIndex = header.indexOf("=");

      return separatorIndex === -1
        ? { key: header, value: "" }
        : {
          key: header.slice(0, separatorIndex),
          value: header.slice(separatorIndex + 1),
        };
    });
}

function setOtlpHeader(entries: HeaderEntry[], key: string, value: string): void {
  const existingIndex = entries.findIndex(
    (entry) => entry.key.toLowerCase() === key.toLowerCase(),
  );
  const header = {
    key,
    value: encodeURIComponent(value),
  };

  if (existingIndex === -1) {
    entries.push(header);
    return;
  }

  entries[existingIndex] = header;
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

function getSiblingSignalEndpoint(endpoint: string, signal: "metrics"): string {
  const trimmedEndpoint = trimTrailingSlashes(endpoint);

  if (trimmedEndpoint.endsWith("/traces")) {
    return `${trimmedEndpoint.slice(0, -"/traces".length)}/${signal}`;
  }

  throw new Error(
    "RawTree Daytona integration requires metricsEndpoint when tracesEndpoint "
      + "does not end with /traces.",
  );
}

function snapshotEnvironment(
  keys: readonly string[],
): Map<string, string | undefined> {
  return new Map(keys.map((key) => [key, process.env[key]]));
}

function restoreEnvironment(previousEnvironment: Map<string, string | undefined>): void {
  for (const [key, value] of previousEnvironment) {
    if (value === undefined) {
      delete process.env[key];
      continue;
    }

    process.env[key] = value;
  }
}
