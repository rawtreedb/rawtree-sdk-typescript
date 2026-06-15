import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { generateText } from "ai";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { RawTree, RawTreeError, type QueryResponse } from "../packages/sdk/src/index.js";
import {
  aiSdkIntegration,
  initRawTree,
  registerOTel,
} from "../packages/otel/src/index.js";

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

  it("captures monitoring events and flushes them to a table", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ inserted: 1 }));
    const rawtree = initRawTree({
      apiKey: "rw_test",
      fetch: fetchMock,
      table: "monitoring_events",
      service: "api",
      environment: "test",
      batch: { intervalMs: 60_000 },
    });

    rawtree.setTag("region", "local");
    rawtree.capture("checkout.started", { userId: "u_123" });
    await rawtree.flush();

    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.rawtree.com/v1/tables/monitoring_events",
    );
    expect(body[0]).toMatchObject({
      type: "checkout.started",
      source: "manual",
      service: "api",
      environment: "test",
      tags: { region: "local" },
      payload: { userId: "u_123" },
    });
  });

  it("allows beforeSend to drop monitoring events", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ inserted: 1 }));
    const rawtree = initRawTree({
      apiKey: "rw_test",
      fetch: fetchMock,
      beforeSend: () => null,
      batch: { intervalMs: 60_000 },
    });

    rawtree.capture("debug.noise", { value: true });
    await rawtree.flush();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("registers OpenTelemetry with a RawTree exporter", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ inserted: 1 }));
    const otel = registerOTel({
      serviceName: "api",
      spanProcessor: "simple",
      apiKey: "rw_test",
      fetch: fetchMock,
    });

    try {
      const tracer = trace.getTracer("rawtree-register-otel-test");
      const span = tracer.startSpan("GET /api/chat", {
        attributes: {
          "http.route": "/api/chat",
          "app.tenant": "team_123",
        },
      });
      span.setStatus({ code: SpanStatusCode.OK });
      span.end();

      await otel.shutdown();
    } finally {
      await otel.shutdown().catch(() => undefined);
    }

    const rows = fetchMock.mock.calls.flatMap((call) => JSON.parse(call[1]?.body as string));
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.rawtree.com/v1/tables/traces");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "otel.span",
      source: "otel",
      status: "ok",
      payload: {
        name: "GET /api/chat",
        kind: "internal",
        attributes: {
          "http.route": "/api/chat",
          "app.tenant": "team_123",
        },
        scope: {
          name: "rawtree-register-otel-test",
        },
        resource: {
          attributes: {
            "service.name": "api",
          },
        },
      },
    });
    expect(rows[0]?.service).toBeUndefined();
    expect(rows[0]?.trace_id).toEqual(expect.any(String));
    expect(rows[0]?.span_id).toEqual(expect.any(String));
    expect(rows[0]?.duration_ms).toEqual(expect.any(Number));
  });

  it("keeps registerOTel tracing alive when a monitoring integration closes", async () => {
    const traceFetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ inserted: 1 }));
    const monitorFetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ inserted: 1 }));
    const otel = registerOTel({
      serviceName: "api",
      spanProcessor: "simple",
      apiKey: "rw_test",
      fetch: traceFetchMock,
    });

    try {
      const monitor = initRawTree({
        apiKey: "rw_test",
        fetch: monitorFetchMock,
        integrations: [
          aiSdkIntegration({ registerOpenTelemetry: false }),
        ],
        batch: { intervalMs: 60_000 },
      });

      await monitor.close();

      const span = trace
        .getTracer("rawtree-register-otel-lifecycle-test")
        .startSpan("after monitoring close");
      span.end();

      await otel.shutdown();
    } finally {
      await otel.shutdown().catch(() => undefined);
    }

    const rows = traceFetchMock.mock.calls.flatMap((call) => JSON.parse(call[1]?.body as string));
    expect(monitorFetchMock).not.toHaveBeenCalled();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "otel.span",
      source: "otel",
      payload: {
        name: "after monitoring close",
        resource: {
          attributes: {
            "service.name": "api",
          },
        },
      },
    });
  });

  it("captures AI SDK generate spans through OpenTelemetry in-process", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ inserted: 1 }));
    const rawtree = initRawTree({
      apiKey: "rw_test",
      fetch: fetchMock,
      table: "ai_events",
      integrations: [
        aiSdkIntegration(),
      ],
      batch: { intervalMs: 60_000 },
    });
    expect(rawtree.integrations.aiSdk).toMatchObject({
      isEnabled: true,
      providerRegistered: true,
      eventName: "ai.sdk.otel.span",
    });

    const usage = {
      inputTokens: { total: 4, noCache: 4, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 2, text: 2, reasoning: 0 },
    };
    const model = {
      specificationVersion: "v3",
      provider: "openai",
      modelId: "gpt-test",
      supportedUrls: {},
      doGenerate: async () => ({
        content: [{ type: "text", text: "hello" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage,
        warnings: [],
      }),
      doStream: async () => {
        throw new Error("not used");
      },
    } as const;

    await generateText({
      model,
      prompt: "Say hello",
      experimental_telemetry: {
        isEnabled: true,
        recordInputs: true,
        recordOutputs: true,
        functionId: "support-summary",
      },
    });
    await rawtree.flush();
    await rawtree.close();

    const rows = fetchMock.mock.calls.flatMap((call) => JSON.parse(call[1]?.body as string));
    const invokeAgentSpan = rows.find((row) => row.payload?.name === "ai.generateText");
    const generateContentSpan = rows.find((row) => row.payload?.name === "ai.generateText.doGenerate");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.rawtree.com/v1/tables/ai_events");
    expect(rows.every((row) => row.type === "ai.sdk.otel.span")).toBe(true);
    expect(invokeAgentSpan).toMatchObject({
      type: "ai.sdk.otel.span",
      source: "ai-sdk",
      status: "ok",
      payload: {
        name: "ai.generateText",
        attributes: {
          "ai.prompt": JSON.stringify({
            prompt: "Say hello",
          }),
        },
      },
    });
    expect(generateContentSpan).toMatchObject({
      type: "ai.sdk.otel.span",
      source: "ai-sdk",
      status: "ok",
      payload: {
        name: "ai.generateText.doGenerate",
        attributes: {
          "ai.response.text": "hello",
          "ai.usage.inputTokens": 4,
          "ai.usage.outputTokens": 2,
        },
      },
    });
    expect(invokeAgentSpan?.trace_id).toEqual(expect.any(String));
    expect(generateContentSpan?.trace_id).toBe(invokeAgentSpan?.trace_id);
    expect(generateContentSpan?.parent_span_id).toBe(invokeAgentSpan?.span_id);
  });

  it("captures AI SDK GenAI semantic convention spans through OpenTelemetry", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ inserted: 1 }));
    const rawtree = initRawTree({
      apiKey: "rw_test",
      fetch: fetchMock,
      table: "ai_events",
      integrations: [
        aiSdkIntegration(),
      ],
      batch: { intervalMs: 60_000 },
    });

    expect(rawtree.integrations.aiSdk.eventName).toBe("ai.sdk.otel.span");

    const tracer = trace.getTracer("rawtree-ai-sdk-gen-ai-test");
    tracer.startActiveSpan("invoke_agent claude-test", {
      attributes: {
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.provider.name": "anthropic",
        "gen_ai.request.model": "claude-test",
        "gen_ai.agent.name": "harness-agent",
        "gen_ai.input.messages": JSON.stringify([
          { role: "user", parts: [{ type: "text", content: "Investigate the incident." }] },
        ]),
      },
    }, (rootSpan) => {
      tracer.startActiveSpan("step 1", {
        attributes: {
          "gen_ai.operation.name": "agent_step",
        },
      }, (stepSpan) => {
        tracer.startActiveSpan("chat claude-test", {
          attributes: {
            "gen_ai.operation.name": "chat",
            "gen_ai.provider.name": "anthropic",
            "gen_ai.request.model": "claude-test",
            "gen_ai.response.id": "resp_123",
            "gen_ai.usage.input_tokens": 12,
            "gen_ai.usage.output_tokens": 6,
            "gen_ai.output.messages": JSON.stringify([
              { role: "assistant", parts: [{ type: "text", content: "Investigated." }] },
            ]),
          },
        }, (chatSpan) => {
          chatSpan.end();
        });
        tracer.startActiveSpan("execute_tool lookupIncident", {
          attributes: {
            "gen_ai.operation.name": "execute_tool",
            "gen_ai.tool.name": "lookupIncident",
            "gen_ai.tool.call.id": "tool_123",
            "gen_ai.tool.type": "function",
            "gen_ai.tool.call.arguments": JSON.stringify({ incidentId: "inc_123" }),
            "gen_ai.tool.call.result": JSON.stringify({ severity: "warning" }),
          },
        }, (toolSpan) => {
          toolSpan.end();
        });
        stepSpan.end();
      });
      rootSpan.end();
    });

    await rawtree.flush();
    await rawtree.close();

    const rows = fetchMock.mock.calls.flatMap((call) => JSON.parse(call[1]?.body as string));
    const invokeAgentSpan = rows.find((row) => row.payload?.name === "invoke_agent claude-test");
    const agentStepSpan = rows.find((row) => row.payload?.name === "step 1");
    const generateContentSpan = rows.find((row) => row.payload?.name === "chat claude-test");
    const toolSpan = rows.find((row) => row.payload?.name === "execute_tool lookupIncident");

    expect(rows.every((row) => row.type === "ai.sdk.otel.span")).toBe(true);
    expect(invokeAgentSpan).toMatchObject({
      source: "ai-sdk",
      payload: {
        name: "invoke_agent claude-test",
        attributes: {
          "gen_ai.operation.name": "invoke_agent",
          "gen_ai.provider.name": "anthropic",
          "gen_ai.request.model": "claude-test",
        },
      },
    });
    expect(agentStepSpan).toMatchObject({
      source: "ai-sdk",
      payload: {
        name: "step 1",
        attributes: {
          "gen_ai.operation.name": "agent_step",
        },
      },
    });
    expect(generateContentSpan).toMatchObject({
      source: "ai-sdk",
      payload: {
        name: "chat claude-test",
        attributes: {
          "gen_ai.operation.name": "chat",
          "gen_ai.response.id": "resp_123",
          "gen_ai.usage.input_tokens": 12,
          "gen_ai.usage.output_tokens": 6,
        },
      },
    });
    expect(toolSpan).toMatchObject({
      source: "ai-sdk",
      payload: {
        name: "execute_tool lookupIncident",
        attributes: {
          "gen_ai.operation.name": "execute_tool",
          "gen_ai.tool.name": "lookupIncident",
          "gen_ai.tool.call.id": "tool_123",
        },
      },
    });
    expect(agentStepSpan?.trace_id).toBe(invokeAgentSpan?.trace_id);
    expect(agentStepSpan?.parent_span_id).toBe(invokeAgentSpan?.span_id);
    expect(generateContentSpan?.trace_id).toBe(invokeAgentSpan?.trace_id);
    expect(generateContentSpan?.parent_span_id).toBe(agentStepSpan?.span_id);
    expect(toolSpan?.trace_id).toBe(invokeAgentSpan?.trace_id);
    expect(toolSpan?.parent_span_id).toBe(agentStepSpan?.span_id);
  });
});
