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

  it("applies the default database only where the operation accepts it", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => jsonResponse(emptyQuery));
    const rawtree = new RawTree({ apiKey: "rw_test", database: "analytics", fetch: fetchMock });

    await rawtree.query.run({ sql: "SELECT 1" });
    await rawtree.tables.insert({ table: "events", body: { event: "signup" }, database: "staging" });
    await rawtree.workflows.list({ organization: "acme", cluster: "main" });

    expect(sent(fetchMock, 0).url).toBe("https://api.rawtree.com/v1/query?database=analytics");
    expect(sent(fetchMock, 1).url).toBe("https://api.rawtree.com/v1/tables/events?database=staging");
    expect(sent(fetchMock, 2).url).toBe("https://api.rawtree.com/v1/workflows?organization=acme&cluster=main");
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
    expect(alias.url).toBe("https://api.rawtree.com/v1/query?database=analytics");
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
    expectTypeOf(rawtree.query<Row>).returns.toEqualTypeOf<Promise<QueryResponse<Row>>>();
    expectTypeOf(rawtree.query.run<Row>).returns.toEqualTypeOf<Promise<QueryResponse<Row>>>();
    expectTypeOf(rawtree.insert<Row>).parameter(0).toHaveProperty("values").toEqualTypeOf<Row | Row[]>();
    expectTypeOf<Awaited<ReturnType<typeof rawtree.insert<Row>>>>().toEqualTypeOf<InsertResponse>();
  });
});
