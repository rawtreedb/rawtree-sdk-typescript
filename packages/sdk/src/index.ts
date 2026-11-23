import packageJson from "../package.json" with { type: "json" };
import { createClient, createConfig, type RequestResult, type ResponseStyle } from "./generated/client/index.js";
import { type Options, Query, RawTreeApi, type Tables } from "./generated/sdk.gen.js";
import type {
  ErrorResponse,
  InsertResponse,
  QueryResponse as GeneratedQueryResponse,
  QueryRunData,
  QueryRunResponse,
} from "./generated/types.gen.js";
import { databaseOperations } from "./database-operations.gen.js";

export * from "./generated/types.gen.js";

const DEFAULT_BASE_URL = "https://api.rawtree.com";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export interface RawTreeOptions {
  apiKey: string;
  database?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  userAgent?: string;
}

export type QueryResponse<Row = unknown> = Omit<GeneratedQueryResponse, "data"> & {
  data: Row[];
};

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

/** Per-request options, such as `signal` and `headers`, accepted as the last argument of every method. */
export type RequestOptions = Options<never, true>;
export type QueryParams = Parameters<Query["run"]>[0];
export type DescribeTableParams = Parameters<Tables["describe"]>[0];

type JsonFormat = "JSON" | "JSONCompact";
type TextFormat = "CSV" | "CSVWithNames" | "TSV" | "TSVWithNames" | "TabSeparated"
  | "JSONEachRow" | "JSONEachRowWithProgress";
type AutomaticQueryOptions = RequestOptions & { parseAs?: "auto"; responseStyle?: never };
type QueryDecoders = {
  arrayBuffer: ArrayBuffer;
  blob: Blob;
  formData: FormData;
  json: unknown;
  stream: Response["body"];
  text: string;
};

type QueryPayload<Format, Decoder> =
  Decoder extends keyof QueryDecoders ? QueryDecoders[Decoder] :
  Format extends JsonFormat | null ? QueryResponse :
  Format extends TextFormat ? string : QueryRunResponse;

// Optional overrides can be absent at runtime. Their result includes the default.
type WithDefault<Value, Default> = Exclude<Value, undefined> | (undefined extends Value ? Default : never);
type Setting<Input, Key extends PropertyKey, Default> = Input extends unknown
  ? Key extends keyof Input ? WithDefault<Input[Key], Default> : Default
  : never;

type QueryCallResult<Params, Opts> = RequestResult<
  { 200: QueryPayload<Setting<Params, "format", "JSON">, Setting<Opts, "parseAs", "auto">> },
  unknown,
  Setting<Opts, "throwOnError", true> & boolean,
  Setting<Opts, "responseStyle", "data"> & ResponseStyle
>;

// Preserve excess-property checks while inferring the caller's format.
type QueryInput<Params, Input extends Params> = Input & Record<Exclude<keyof Input, keyof Params>, never>;

function typedQuery<Params extends { format?: string | null }>(
  execute: (parameters: Params, options?: Options<never, boolean>) => Promise<QueryRunResponse | undefined>,
) {
  function run<Row = unknown>(
    parameters: Params & { format?: JsonFormat | null },
    options?: AutomaticQueryOptions,
  ): Promise<QueryResponse<Row>>;
  function run<const Input extends Params>(parameters: QueryInput<Params, Input>): QueryCallResult<Input, undefined>;
  function run<const Input extends Params, const Opts extends Options<never, boolean> | undefined>(
    parameters: QueryInput<Params, Input>, options: Opts,
  ): QueryCallResult<Input, Opts>;
  function run(parameters: Params, options?: Options<never, boolean>): Promise<unknown> {
    // Return NDJSON as text by default, including JSONEachRow from older servers
    // that use application/json for the same newline-delimited bytes.
    const format = parameters.format?.trim().toLowerCase();
    const rowFormat = format === "jsoneachrow" || format === "jsoneachrowwithprogress";
    const decoder = options?.parseAs ?? "auto";
    return execute(parameters, {
      ...options,
      parseAs: rowFormat && decoder === "auto" ? "text" : decoder,
      responseStyle: options?.responseStyle ?? "data",
    });
  }
  return run;
}

class TypedQuery extends Query {
  override run = typedQuery<QueryParams>(super.run.bind(this));
  override runReadOnly = typedQuery<Parameters<Query["runReadOnly"]>[0]>(super.runReadOnly.bind(this));
}

/** `rawtree.query({ sql })` is shorthand for `rawtree.query.run({ sql })`. */
export type QueryClient = TypedQuery & TypedQuery["run"];

export type InsertBody = NonNullable<Parameters<Tables["insert"]>[0]["body"]>;
export type InsertRow = Record<string, unknown>;

export type InsertParams<Row extends InsertRow = InsertRow> = Omit<
  Parameters<Tables["insert"]>[0],
  "body"
> & {
  values: Row | Row[];
};

/** Calls `fn`, and reads every other property, including generated methods added later, from `group`. */
function callable<Group extends object, Fn extends (...args: never[]) => unknown>(
  group: Group,
  fn: Fn,
): Fn & Group {
  return new Proxy(fn, {
    get(target, key) {
      if (!(key in group)) return Reflect.get(target, key);
      const value = Reflect.get(group, key, group);
      return typeof value === "function" ? value.bind(group) : value;
    },
    has: (target, key) => key in group || key in target,
  }) as Fn & Group;
}

export class RawTree extends RawTreeApi {
  private queryClient?: QueryClient;

  constructor(options: RawTreeOptions) {
    if (!options || typeof options.apiKey !== "string" || options.apiKey.trim() === "") {
      throw new TypeError("RawTree requires a non-empty apiKey.");
    }

    const client = createClient(
      createConfig({
        baseUrl: (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
        fetch: options.fetch,
        auth: () => options.apiKey,
        headers: {
          Accept: "application/json",
          "User-Agent": options.userAgent ?? `rawtree-sdk-typescript/${packageJson.version}`,
        },
        throwOnError: true,
        responseStyle: "data",
      }),
    );

    const { database } = options;
    if (database !== undefined) {
      client.interceptors.request.use((request, opts) =>
        databaseOperations.has(`${opts.method} ${opts.url}`)
          ? withDefaultDatabase(request, database)
          : request,
      );
    }
    client.interceptors.error.use((error, response) =>
      response ? new RawTreeError(response, error as Partial<ErrorResponse> | string) : error,
    );

    super({ client });
  }

  override get query(): QueryClient {
    if (!this.queryClient) {
      const group = new TypedQuery({ client: this.client });
      this.queryClient = callable(group, group.run.bind(group));
    }
    return this.queryClient;
  }

  /** Shorthand for `rawtree.tables.insert` that takes the rows as `values`. */
  insert<Row extends InsertRow = InsertRow>(
    { values, ...parameters }: InsertParams<Row>,
    options?: RequestOptions,
  ): Promise<InsertResponse> {
    // Only transform=firehose returns a FirehoseInsertResponse, and its body is a
    // Firehose envelope that AWS sends, not rows passed as `values`.
    return this.tables.insert({ ...parameters, body: values }, options) as Promise<InsertResponse>;
  }
}

export type { QueryRunData };

function withDefaultDatabase(request: Request, database: string): Request {
  const url = new URL(request.url);
  if (url.searchParams.has("database")) return request;
  url.searchParams.set("database", database);
  return new Request(url, request);
}
