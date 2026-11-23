import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import packageJson from "../packages/sdk/package.json" with { type: "json" };
import { RawTree, RawTreeError, type InsertResponse, type QueryResponse } from "../packages/sdk/src/index.js";

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
}

function sent(fetchMock: ReturnType<typeof vi.fn>, call = 0): Request {
  return fetchMock.mock.calls[call]?.[0] as Request;
}

async function summary(fetchMock: ReturnType<typeof vi.fn>, call: number) {
  const request = sent(fetchMock, call);
  return { method: request.method, url: request.url, body: await request.text() };
}

const emptyQuery = { meta: [], data: [], rows: 0, statistics: { elapsed: 0, rows_read: 0, bytes_read: 0 } };

describe("RawTree", () => {
  it("requires a non-empty api key", () => {
    expect(() => new RawTree({ apiKey: "" })).toThrow("apiKey");
  });

  it("executes typed queries", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        meta: [{ name: "event", type: "String" }],
        data: [{ event: "signup" }],
        rows: 1,
        statistics: { elapsed: 0.01, rows_read: 1, bytes_read: 10 },
      }),
    );
    const rawtree = new RawTree({ apiKey: "rw_test", fetch: fetchMock });

    const result = await rawtree.query.run<{ event: string }>({ sql: "SELECT event FROM events" });

    expect(result.data[0]?.event).toBe("signup");
    const request = sent(fetchMock);
    expect(request.url).toBe("https://api.rawtree.com/v1/query");
    expect(request.method).toBe("POST");
    expect(await request.text()).toBe(JSON.stringify({ sql: "SELECT event FROM events" }));
    expect(request.headers.get("Authorization")).toBe("Bearer rw_test");
    expect(request.headers.get("Content-Type")).toBe("application/json");
    expect(request.headers.get("User-Agent")).toBe(`rawtree-sdk-typescript/${packageJson.version}`);
  });

  it.each([
    ["CSVWithNames", "text/csv", "n\n1\n"],
    ["TabSeparated", "text/tab-separated-values", "1\ta\n"],
    ["JSONEachRow", "application/x-ndjson", '{"n":1}\n{"n":2}\n'],
    ["JSONEachRow", "application/json", '[{"n":1},{"n":2}]'],
    ["JSONEachRow", "application/json", '{"n":1}\n{"n":2}\n'],
    ["JSONEachRowWithProgress", "application/x-ndjson", '{"progress":{}}\n{"row":{"n":1}}\n'],
  ] as const)("returns %s queries as text on GET and POST", async (format, mediaType, body) => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () =>
      new Response(body, { headers: { "Content-Type": mediaType } }),
    );
    const rawtree = new RawTree({ apiKey: "rw_test", fetch: fetchMock });
    const query = { sql: "SELECT 1", format };

    const get = await rawtree.query.runReadOnly(query);
    const post = await rawtree.query(query);
    expectTypeOf(get).toEqualTypeOf<string>();
    expectTypeOf(post).toEqualTypeOf<string>();
    expect(get).toBe(body);
    expect(post).toBe(body);
  });

  it("honors an explicit stream decoder for progress queries", async () => {
    const response = new Response('{"progress":{}}\n', { headers: { "Content-Type": "application/x-ndjson" } });
    const rawtree = new RawTree({ apiKey: "rw_test", fetch: vi.fn<typeof fetch>().mockResolvedValue(response) });

    const stream = await rawtree.query.runReadOnly(
      { sql: "SELECT 1", format: "JSONEachRowWithProgress" },
      { parseAs: "stream" },
    );
    expectTypeOf(stream).toEqualTypeOf<Response["body"]>();
    expect(stream).toBe(response.body);
  });

  it("returns field-style results for successful and failed queries", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("1\n", { headers: { "Content-Type": "text/csv" } }))
      .mockResolvedValueOnce(jsonResponse({ message: "Invalid SQL" }, { status: 400 }));
    const rawtree = new RawTree({ apiKey: "rw_test", fetch: fetchMock });
    const params = { sql: "SELECT 1", format: "CSV" } as const;

    const success = await rawtree.query.runReadOnly(params, { responseStyle: "fields" });
    expectTypeOf(success.data).toEqualTypeOf<string>();
    expect(success.data).toBe("1\n");
    expect(success.response.status).toBe(200);

    const failure = await rawtree.query(params, { responseStyle: "fields", throwOnError: false });
    expectTypeOf(failure.data).toEqualTypeOf<string | undefined>();
    expect(failure.data).toBeUndefined();
    expect(failure.error).toBeInstanceOf(RawTreeError);
    expect(failure.response?.status).toBe(400);
  });

  it("includes defaults in the return type for optional overrides", async () => {
    const rawtree = new RawTree({
      apiKey: "rw_test",
      fetch: vi.fn<typeof fetch>().mockImplementation(async () => jsonResponse(emptyQuery)),
    });
    const params: { sql: string; format?: "CSV" } = { sql: "SELECT 1" };
    const decoder: { parseAs?: "text" } = {};
    const style: { responseStyle?: "fields" } = {};

    const formatted = await rawtree.query(params);
    const decoded = await rawtree.query.runReadOnly({ sql: params.sql }, decoder);
    const styled = await rawtree.query.run({ sql: params.sql }, style);
    expectTypeOf(formatted).toEqualTypeOf<QueryResponse | string>();
    expectTypeOf(decoded).toEqualTypeOf<QueryResponse | string>();
    expectTypeOf(styled).toEqualTypeOf<QueryResponse | { data: QueryResponse; request: Request; response: Response }>();
    const unset = await rawtree.query({ sql: params.sql }, { responseStyle: undefined, parseAs: undefined });
    expectTypeOf(unset).toEqualTypeOf<QueryResponse>();
    expect([formatted, decoded, styled, unset]).toEqual(Array(4).fill(emptyQuery));
  });

  it("requires request options in the second argument", () => {
    const rawtree = new RawTree({ apiKey: "rw_test" });
    const invalid = () => rawtree.query({
      sql: "SELECT 1",
      // @ts-expect-error The query parameters do not carry request options.
      signal: AbortSignal.abort(),
    });
    expectTypeOf(invalid).toBeFunction();
  });

  it("omits the body for a URL insert", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ inserted: 1 }));
    const rawtree = new RawTree({ apiKey: "rw_test", fetch: fetchMock });

    type Body = Parameters<typeof rawtree.tables.insert>[0]["body"];
    expectTypeOf<null>().not.toMatchTypeOf<Body>();
    await rawtree.tables.insert({ table: "events", url: "https://example.com/rows" });
    expect(sent(fetchMock).body).toBeNull();
  });

  it("applies the default database only where the operation accepts it", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => jsonResponse(emptyQuery));
    const rawtree = new RawTree({ apiKey: "rw_test", database: "analytics", fetch: fetchMock });

    await rawtree.query.run({ sql: "SELECT 1" });
    await rawtree.tables.insert({ table: "events", body: { event: "signup" }, database: "staging" });
    await rawtree.tables.list({}, { headers: { "X-RawTree-Database": "logs" } });
    await rawtree.workflows.list();

    const database = (call: number) => sent(fetchMock, call).headers.get("x-rawtree-database");
    expect(sent(fetchMock, 0).url).toBe("https://api.rawtree.com/v1/query");
    expect(database(0)).toBe("analytics");
    expect(sent(fetchMock, 1).url).toBe("https://api.rawtree.com/v1/tables/events?database=staging");
    expect(database(1)).toBeNull();
    expect(database(2)).toBe("logs");
    expect(database(3)).toBeNull();
  });

  it("trims the default database and rejects blank names", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => jsonResponse(emptyQuery));
    const rawtree = new RawTree({ apiKey: "rw_test", database: " analytics ", fetch: fetchMock });

    await rawtree.query.run({ sql: "SELECT 1" });

    expect(sent(fetchMock).headers.get("x-rawtree-database")).toBe("analytics");
    expect(() => new RawTree({ apiKey: "rw_test", database: "  " })).toThrow("database");
  });

  it("keeps bodies replayable with a default database", async () => {
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        if (request.url?.startsWith("/v1/tables/redirect")) {
          response.writeHead(307, { Location: "/v1/tables/events" }).end();
          return;
        }
        response
          .writeHead(200, { "Content-Type": "application/json" })
          .end(JSON.stringify({ inserted: 1, received: { url: request.url, database: request.headers["x-rawtree-database"], body } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const rawtree = new RawTree({ apiKey: "rw_test", database: "analytics", baseUrl: `http://127.0.0.1:${port}` });
      const expected = { url: "/v1/tables/events", database: "analytics", body: JSON.stringify({ event: "signup" }) };

      const keepalive = await rawtree.tables.insert({ table: "events", body: { event: "signup" } }, { keepalive: true });
      const redirected = await rawtree.tables.insert({ table: "redirect", body: { event: "signup" } });

      expect(keepalive).toMatchObject({ received: expected });
      expect(redirected).toMatchObject({ received: expected });
    } finally {
      server.close();
    }
  });

  it("inserts with a transform and encodes path params", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ inserted: 1 }));
    const rawtree = new RawTree({ apiKey: "rw_test", baseUrl: "https://example.com/", fetch: fetchMock });

    await expect(
      rawtree.tables.insert({
        table: "user events",
        body: { resourceSpans: [] },
        transform: "otlp-traces",
        database: "analytics",
      }),
    ).resolves.toEqual({ inserted: 1 });

    const request = sent(fetchMock);
    expect(request.url).toBe(
      "https://example.com/v1/tables/user%20events?transform=otlp-traces&database=analytics",
    );
    expect(await request.text()).toBe(JSON.stringify({ resourceSpans: [] }));
  });

  it("passes request options through", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ tables: [] }));
    const rawtree = new RawTree({ apiKey: "rw_test", fetch: fetchMock });
    const abortController = new AbortController();

    await rawtree.tables.list({}, { signal: abortController.signal, headers: { "X-Test": "yes" } });

    const request = sent(fetchMock);
    expect(request.headers.get("X-Test")).toBe("yes");
    abortController.abort();
    expect(request.signal.aborted).toBe(true);
  });

  it("throws RawTreeError for JSON errors", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ error: "bad_request", message: "Invalid SQL", hint: "Use SELECT" }, { status: 400 }),
    );
    const rawtree = new RawTree({ apiKey: "rw_test", fetch: fetchMock });

    await expect(rawtree.query.run({ sql: "DROP TABLE events" })).rejects.toMatchObject({
      name: "RawTreeError",
      status: 400,
      error: "bad_request",
      message: "Invalid SQL",
      hint: "Use SELECT",
    });
  });

  it("throws RawTreeError for non-JSON errors", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("not found", { status: 404 }));
    const rawtree = new RawTree({ apiKey: "rw_test", fetch: fetchMock });

    await expect(rawtree.tables.list()).rejects.toBeInstanceOf(RawTreeError);
  });

  it("keeps abort and body errors on successful responses", async () => {
    const server = createServer((request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      if (request.url?.startsWith("/v1/tables")) response.end("{not json");
      else response.write('{"data":[');
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const controller = new AbortController();
      const rawtree = new RawTree({
        apiKey: "rw_test",
        baseUrl: `http://127.0.0.1:${port}`,
        fetch: async (request) => {
          const response = await fetch(request);
          if ((request as Request).url.includes("/v1/query")) setTimeout(() => controller.abort());
          return response;
        },
      });

      const aborted = await rawtree.query
        .run({ sql: "SELECT 1" }, { signal: controller.signal })
        .catch((error) => error);
      expect(aborted).not.toBeInstanceOf(RawTreeError);
      expect(aborted).toMatchObject({ name: "AbortError" });
      const malformed = await rawtree.tables.list().catch((error) => error);
      expect(malformed).not.toBeInstanceOf(RawTreeError);
      expect(malformed).toBeInstanceOf(SyntaxError);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it("reaches operations the hand-written SDK never had", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ id: "s1" }, { status: 201 }));
    const rawtree = new RawTree({ apiKey: "rw_test", fetch: fetchMock });

    await rawtree.workflows.sinks.create({
      workflow_id: "wf_1",
      body: { type: "table", settings: { database: "analytics", table: "alerts" } },
    });

    expect(sent(fetchMock).url).toBe("https://api.rawtree.com/v1/workflows/wf_1/sinks");
  });

  it("keeps query rows generic", () => {
    type EventRow = { event: string };
    expectTypeOf<QueryResponse<EventRow>["data"]>().toEqualTypeOf<EventRow[]>();
  });
});

describe("shorthand aliases", () => {
  it("rawtree.query() sends the same request as rawtree.query.run()", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => jsonResponse(emptyQuery));
    const rawtree = new RawTree({ apiKey: "rw_test", database: "analytics", fetch: fetchMock });

    await rawtree.query({ sql: "SELECT 1" });
    await rawtree.query.run({ sql: "SELECT 1" });

    const [alias, grouped] = [await summary(fetchMock, 0), await summary(fetchMock, 1)];
    expect(alias).toEqual(grouped);
    expect(alias.url).toBe("https://api.rawtree.com/v1/query");
    expect(sent(fetchMock, 0).headers.get("x-rawtree-database")).toBe("analytics");
  });

  it("keeps the rest of the query group reachable", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ query: "SELECT 1" }));
    const rawtree = new RawTree({ apiKey: "rw_test", fetch: fetchMock });

    await rawtree.query.format({ sql: "select 1" });

    expect((await summary(fetchMock, 0)).url).toBe("https://api.rawtree.com/v1/query-format");
    expect(typeof rawtree.query).toBe("function");
    expect("run" in rawtree.query && "format" in rawtree.query).toBe(true);
    expect(rawtree.query).toBe(rawtree.query);
  });

  it("rawtree.insert({ values }) sends the same request as rawtree.tables.insert({ body })", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => jsonResponse({ inserted: 1 }));
    const rawtree = new RawTree({ apiKey: "rw_test", fetch: fetchMock });

    // The exact call @rawtree/otel makes today.
    await rawtree.insert({ table: "traces", values: { resourceSpans: [] }, transform: "otlp-traces" });
    await rawtree.tables.insert({ table: "traces", body: { resourceSpans: [] }, transform: "otlp-traces" });

    const [alias, grouped] = [await summary(fetchMock, 0), await summary(fetchMock, 1)];
    expect(alias).toEqual(grouped);
    expect(alias).toEqual({
      method: "POST",
      url: "https://api.rawtree.com/v1/tables/traces?transform=otlp-traces",
      body: JSON.stringify({ resourceSpans: [] }),
    });
  });

  it("types rows on both forms", () => {
    type Row = { event: string };
    const rawtree = new RawTree({ apiKey: "rw_test" });
    const checkRows = () => [
      rawtree.query<Row>({ sql: "SELECT 1" }),
      rawtree.query.run<Row>({ sql: "SELECT 1", format: "JSON" }),
      rawtree.query.runReadOnly<Row>({ sql: "SELECT 1" }),
    ];
    expectTypeOf(checkRows).returns.toEqualTypeOf<Promise<QueryResponse<Row>>[]>();
    expectTypeOf(rawtree.insert<Row>).parameter(0).toHaveProperty("values").toEqualTypeOf<Row | Row[]>();
    expectTypeOf<Awaited<ReturnType<typeof rawtree.insert<Row>>>>().toEqualTypeOf<InsertResponse>();
  });
});
