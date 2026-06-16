export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export interface RawTreeOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

export interface RequestOptions {
  signal?: AbortSignal;
  headers?: HeadersInit;
}

export interface InsertOptions extends RequestOptions {
  transform?: string;
}

export interface QueryRequest {
  sql: string;
}

export interface QueryResponseColumnMeta {
  name: string;
  type: string;
}

export interface QueryResponseStatistics {
  elapsed: number;
  rows_read: number;
  bytes_read: number;
}

export interface QueryResponse<Row = unknown> {
  meta: QueryResponseColumnMeta[];
  data: Row[];
  rows: number;
  statistics: QueryResponseStatistics;
  hints?: string[] | null;
}

export interface InsertResponse {
  inserted: number;
}

export interface ColumnInfo {
  name: string;
  type: string;
}

export interface TableInfo {
  name: string;
  created_at: string;
  total_rows: number;
  total_bytes: number;
}

export interface TableProjectRef {
  name: string;
}

export interface TableOrganizationRef {
  name: string;
}

export interface TablesResponse {
  tables: TableInfo[];
  project: TableProjectRef;
  organization: TableOrganizationRef;
}

export interface DescribeTableEntity extends TableInfo {
  columns: ColumnInfo[];
}

export interface DescribeTableResponse {
  table: DescribeTableEntity;
  project: TableProjectRef;
  organization: TableOrganizationRef;
}

export interface ErrorResponse {
  error: string;
  message: string;
  hint: string;
}

interface RequestConfig extends RequestOptions {
  method: "GET" | "POST";
  path: string;
  body?: unknown;
}

const DEFAULT_BASE_URL = "https://api.rawtree.com";

export class RawTreeError extends Error {
  readonly status: number;
  readonly error?: string;
  readonly hint?: string;
  readonly response: Response;

  constructor(response: Response, body?: Partial<ErrorResponse> | string) {
    const message =
      typeof body === "object" && body?.message
        ? body.message
        : typeof body === "string" && body.length > 0
          ? body
          : `RawTree request failed with status ${response.status}`;

    super(message);
    this.name = "RawTreeError";
    this.status = response.status;
    this.response = response;

    if (typeof body === "object") {
      this.error = body.error;
      this.hint = body.hint;
    }
  }
}

export class RawTree {
  readonly tables: {
    list: (options?: RequestOptions) => Promise<TablesResponse>;
    describe: (
      table: string,
      options?: RequestOptions,
    ) => Promise<DescribeTableResponse>;
  };

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: RawTreeOptions) {
    if (!options || typeof options.apiKey !== "string" || options.apiKey.trim() === "") {
      throw new TypeError("RawTree requires a non-empty apiKey.");
    }

    const fetchImpl = options.fetch ?? globalThis.fetch;

    if (typeof fetchImpl !== "function") {
      throw new TypeError("RawTree requires a fetch implementation.");
    }

    this.apiKey = options.apiKey;
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    this.fetchImpl = fetchImpl;
    this.tables = {
      list: (requestOptions) => this.request<TablesResponse>({
        method: "GET",
        path: "/v1/tables",
        ...requestOptions,
      }),
      describe: (table, requestOptions) => this.request<DescribeTableResponse>({
        method: "GET",
        path: `/v1/tables/${encodeURIComponent(table)}`,
        ...requestOptions,
      }),
    };
  }

  query<Row = unknown>(
    sql: string | QueryRequest,
    options?: RequestOptions,
  ): Promise<QueryResponse<Row>> {
    const body = typeof sql === "string" ? { sql } : sql;

    return this.request<QueryResponse<Row>>({
      method: "POST",
      path: "/v1/query",
      body,
      ...options,
    });
  }

  insert<Row extends JsonObject = JsonObject>(
    table: string,
    rows: Row | Row[],
    options?: InsertOptions,
  ): Promise<InsertResponse> {
    const { transform, ...requestOptions } = options ?? {};
    const query = transform
      ? `?transform=${encodeURIComponent(transform)}`
      : "";

    return this.request<InsertResponse>({
      method: "POST",
      path: `/v1/tables/${encodeURIComponent(table)}${query}`,
      body: rows,
      ...requestOptions,
    });
  }

  private async request<T>(config: RequestConfig): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${config.path}`, {
      method: config.method,
      headers: this.buildHeaders(config),
      body: config.body === undefined ? undefined : JSON.stringify(config.body),
      signal: config.signal,
    });

    if (!response.ok) {
      throw new RawTreeError(response, await readErrorBody(response));
    }

    return response.json() as Promise<T>;
  }

  private buildHeaders(config: RequestConfig): Headers {
    const headers = new Headers(config.headers);
    headers.set("Authorization", `Bearer ${this.apiKey}`);

    if (config.body !== undefined && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    if (!headers.has("Accept")) {
      headers.set("Accept", "application/json");
    }

    return headers;
  }
}

async function readErrorBody(response: Response): Promise<Partial<ErrorResponse> | string> {
  const contentType = response.headers.get("Content-Type") ?? "";

  if (contentType.includes("application/json")) {
    return response.json() as Promise<Partial<ErrorResponse>>;
  }

  return response.text();
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}
