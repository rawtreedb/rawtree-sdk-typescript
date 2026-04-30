import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { RawTree, RawTreeError, type QueryResponse } from "../src/index.js";

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
}

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

    const result = await rawtree.query<{ event: string }>("SELECT event FROM events");

    expect(result.data[0]?.event).toBe("signup");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.rawtree.com/v1/query",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ sql: "SELECT event FROM events" }),
      }),
    );

    const headers = fetchMock.mock.calls[0]?.[1]?.headers;
    expect(headers).toBeInstanceOf(Headers);
    expect((headers as Headers).get("Authorization")).toBe("Bearer rw_test");
    expect((headers as Headers).get("Content-Type")).toBe("application/json");
  });

  it("accepts query request objects", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        meta: [],
        data: [],
        rows: 0,
        statistics: { elapsed: 0, rows_read: 0, bytes_read: 0 },
      }),
    );
    const rawtree = new RawTree({ apiKey: "rw_test", fetch: fetchMock });

    await rawtree.query({ sql: "SELECT 1" });

    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ sql: "SELECT 1" }));
  });

  it("inserts a JSON object or array", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ inserted: 2 }));
    const rawtree = new RawTree({
      apiKey: "rw_test",
      baseUrl: "https://example.com/",
      fetch: fetchMock,
    });

    await expect(rawtree.insert("events", [{ event: "signup" }, { event: "purchase" }]))
      .resolves.toEqual({ inserted: 2 });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/v1/tables/events",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify([{ event: "signup" }, { event: "purchase" }]),
      }),
    );
  });

  it("lists tables", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        tables: [{ name: "events", created_at: "2026-04-30", total_rows: 1, total_bytes: 10 }],
        project: { name: "app" },
        organization: { name: "team" },
      }),
    );
    const rawtree = new RawTree({ apiKey: "rw_test", fetch: fetchMock });

    const result = await rawtree.tables.list();

    expect(result.tables[0]?.name).toBe("events");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.rawtree.com/v1/tables");
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("GET");
  });

  it("describes a table", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        table: {
          name: "user events",
          created_at: "2026-04-30",
          total_rows: 1,
          total_bytes: 10,
          columns: [{ name: "event", type: "String" }],
        },
        project: { name: "app" },
        organization: { name: "team" },
      }),
    );
    const rawtree = new RawTree({ apiKey: "rw_test", fetch: fetchMock });

    await rawtree.tables.describe("user events");

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.rawtree.com/v1/tables/user%20events",
    );
  });

  it("passes request options through", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ inserted: 1 }));
    const rawtree = new RawTree({ apiKey: "rw_test", fetch: fetchMock });
    const abortController = new AbortController();

    await rawtree.insert("events", { event: "signup" }, {
      signal: abortController.signal,
      headers: { "X-Test": "yes" },
    });

    const init = fetchMock.mock.calls[0]?.[1];
    const headers = init?.headers as Headers;
    expect(init?.signal).toBe(abortController.signal);
    expect(headers.get("X-Test")).toBe("yes");
  });

  it("throws RawTreeError for JSON errors", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        { error: "bad_request", message: "Invalid SQL", hint: "Use SELECT" },
        { status: 400 },
      ),
    );
    const rawtree = new RawTree({ apiKey: "rw_test", fetch: fetchMock });

    await expect(rawtree.query("DROP TABLE events")).rejects.toMatchObject({
      name: "RawTreeError",
      status: 400,
      error: "bad_request",
      message: "Invalid SQL",
      hint: "Use SELECT",
    });
  });

  it("throws RawTreeError for non-JSON errors", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("not found", { status: 404 }),
    );
    const rawtree = new RawTree({ apiKey: "rw_test", fetch: fetchMock });

    await expect(rawtree.tables.list()).rejects.toBeInstanceOf(RawTreeError);
  });

  it("keeps query rows generic", () => {
    type EventRow = { event: string };
    expectTypeOf<QueryResponse<EventRow>["data"]>().toEqualTypeOf<EventRow[]>();
  });
});
