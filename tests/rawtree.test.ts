import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { generateText } from "ai";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { RawTree, RawTreeError, type QueryResponse } from "../src/index.js";
import { initRawTree } from "../src/monitoring.js";
import { aiSdkIntegration } from "../src/integrations/ai-sdk.js";
import { daytonaIntegration } from "../src/integrations/daytona.js";

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

  it("captures AI SDK generate spans through OpenTelemetry in-process", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ inserted: 1 }));
    const rawtree = initRawTree({
      apiKey: "rw_test",
      fetch: fetchMock,
      table: "ai_events",
      integrations: [
        aiSdkIntegration({
          captureInputs: true,
          captureOutputs: true,
        }),
      ],
      batch: { intervalMs: 60_000 },
    });
    expect(rawtree.integrations.aiSdk).toMatchObject({
      isEnabled: true,
      providerRegistered: true,
    });
    expect(rawtree.integrations.aiSdk.capturedOperations).toContain("invoke_agent");

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
    const invokeAgentSpan = rows.find((row) => row.type === "ai.sdk.invoke_agent");
    const generateContentSpan = rows.find((row) => row.type === "ai.sdk.generate_content");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.rawtree.com/v1/tables/ai_events");
    expect(rows.find((row) => row.type === "ai.sdk.start")).toBeUndefined();
    expect(invokeAgentSpan).toMatchObject({
      type: "ai.sdk.invoke_agent",
      source: "ai-sdk",
      status: "ok",
      payload: {
        name: "invoke_agent support-summary",
        originalName: "ai.generateText",
        operation: "invoke_agent",
        operationId: "ai.generateText",
        provider: "openai",
        model: "gpt-test",
        functionId: "support-summary",
        attributes: {
          "ai.prompt": JSON.stringify({
            prompt: "Say hello",
          }),
          "gen_ai.operation.name": "invoke_agent",
        },
      },
    });
    expect(generateContentSpan).toMatchObject({
      type: "ai.sdk.generate_content",
      source: "ai-sdk",
      status: "ok",
      payload: {
        originalName: "ai.generateText.doGenerate",
        operation: "generate_content",
        operationId: "ai.generateText.doGenerate",
        provider: "openai",
        model: "gpt-test",
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

  it("bridges AI SDK telemetry integrations into OpenTelemetry spans", async () => {
    type TelemetryBridge = {
      onStart?: (event: unknown) => void;
      onLanguageModelCallStart?: (event: unknown) => void;
      onLanguageModelCallEnd?: (event: unknown) => void;
      onToolExecutionStart?: (event: unknown) => void;
      onToolExecutionEnd?: (event: unknown) => void;
      onEnd?: (event: unknown) => void;
      executeLanguageModelCall?: <T>(options: {
        callId: string;
        execute: () => PromiseLike<T>;
      }) => PromiseLike<T>;
      executeTool?: <T>(options: {
        callId: string;
        toolCallId: string;
        execute: () => PromiseLike<T>;
      }) => PromiseLike<T>;
    };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ inserted: 1 }));
    const rawtree = initRawTree({
      apiKey: "rw_test",
      fetch: fetchMock,
      table: "ai_events",
      integrations: [
        aiSdkIntegration({
          captureInputs: true,
          captureOutputs: true,
        }),
      ],
      batch: { intervalMs: 60_000 },
    });
    const bridge = (globalThis as {
      AI_SDK_TELEMETRY_INTEGRATIONS?: TelemetryBridge[];
    }).AI_SDK_TELEMETRY_INTEGRATIONS?.find((integration) => (
      typeof integration.executeLanguageModelCall === "function"
    ));

    expect(bridge).toBeDefined();

    bridge?.onStart?.({
      callId: "call_123",
      operationId: "ai.streamText",
      provider: "anthropic",
      modelId: "claude-test",
      prompt: "Investigate the incident.",
      tools: {
        lookupIncident: {},
      },
      functionId: "harness-agent",
    });
    bridge?.onLanguageModelCallStart?.({
      callId: "call_123",
      provider: "anthropic",
      modelId: "claude-test",
      messages: [{ role: "user", content: "Investigate the incident." }],
      tools: [{ name: "lookupIncident" }],
      functionId: "harness-agent",
    });
    await bridge?.executeLanguageModelCall?.({
      callId: "call_123",
      execute: async () => "stream-created",
    });
    bridge?.onLanguageModelCallEnd?.({
      callId: "call_123",
      provider: "anthropic",
      modelId: "claude-test",
      finishReason: "tool-calls",
      usage: {
        inputTokens: 12,
        outputTokens: 6,
        totalTokens: 18,
      },
      content: [{ type: "tool-call", toolName: "lookupIncident" }],
      responseId: "resp_123",
    });
    bridge?.onToolExecutionStart?.({
      callId: "call_123",
      functionId: "harness-agent",
      toolCall: {
        toolCallId: "tool_123",
        toolName: "lookupIncident",
        input: { incidentId: "inc_123" },
      },
    });
    await bridge?.executeTool?.({
      callId: "call_123",
      toolCallId: "tool_123",
      execute: async () => ({ severity: "warning" }),
    });
    bridge?.onToolExecutionEnd?.({
      callId: "call_123",
      toolExecutionMs: 7,
      toolCall: {
        toolCallId: "tool_123",
        toolName: "lookupIncident",
      },
      toolOutput: {
        type: "tool-result",
        output: { severity: "warning" },
      },
    });
    bridge?.onEnd?.({
      callId: "call_123",
      model: {
        provider: "anthropic",
        modelId: "claude-test",
      },
      finishReason: "stop",
      text: "Investigated.",
      totalUsage: {
        inputTokens: 12,
        outputTokens: 6,
        totalTokens: 18,
      },
    });

    await rawtree.flush();
    await rawtree.close();

    const rows = fetchMock.mock.calls.flatMap((call) => JSON.parse(call[1]?.body as string));
    const invokeAgentSpan = rows.find((row) => row.type === "ai.sdk.invoke_agent");
    const generateContentSpan = rows.find((row) => row.type === "ai.sdk.generate_content");
    const toolSpan = rows.find((row) => row.type === "ai.sdk.execute_tool");

    expect(invokeAgentSpan).toMatchObject({
      source: "ai-sdk",
      payload: {
        name: "invoke_agent harness-agent",
        operation: "invoke_agent",
        operationId: "ai.streamText",
      },
    });
    expect(generateContentSpan).toMatchObject({
      source: "ai-sdk",
      payload: {
        operation: "generate_content",
        operationId: "ai.streamText.doStream",
        provider: "anthropic",
        model: "claude-test",
      },
    });
    expect(toolSpan).toMatchObject({
      source: "ai-sdk",
      payload: {
        name: "execute_tool lookupIncident",
        operation: "execute_tool",
        toolName: "lookupIncident",
        toolCallId: "tool_123",
      },
    });
    expect(generateContentSpan?.trace_id).toBe(invokeAgentSpan?.trace_id);
    expect(generateContentSpan?.parent_span_id).toBe(invokeAgentSpan?.span_id);
    expect(toolSpan?.trace_id).toBe(invokeAgentSpan?.trace_id);
    expect(toolSpan?.parent_span_id).toBe(invokeAgentSpan?.span_id);
  });

  it("captures Daytona spans through OpenTelemetry in-process", async () => {
    const previousEndpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ inserted: 1 }));
    const rawtree = initRawTree({
      apiKey: "rw_test",
      fetch: fetchMock,
      table: "daytona_events",
      integrations: [
        daytonaIntegration({
          componentNames: ["Daytona"],
        }),
      ],
      batch: { intervalMs: 60_000 },
    });

    try {
      expect(rawtree.integrations.daytona).toMatchObject({
        isEnabled: true,
        providerRegistered: true,
      });
      expect(rawtree.integrations.daytona.capturedComponents).toContain("Daytona");
      expect(process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT).toBe(previousEndpoint);

      const tracer = trace.getTracer("rawtree-daytona-test");
      const ignoredSpan = tracer.startSpan("Other.create", {
        attributes: {
          component: "Other",
          method: "create",
        },
      });
      ignoredSpan.end();

      const span = tracer.startSpan("Daytona.create", {
        attributes: {
          component: "Daytona",
          method: "create",
          "http.response.status_code": 200,
        },
      });
      span.setStatus({ code: SpanStatusCode.OK });
      span.end();

      await rawtree.flush();
      await rawtree.close();

      const rows = fetchMock.mock.calls.flatMap((call) => JSON.parse(call[1]?.body as string));
      expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.rawtree.com/v1/tables/daytona_events");
      expect(rows[0]).toMatchObject({
        type: "daytona.otel.span",
        source: "daytona",
        status: "ok",
        payload: {
          name: "Daytona.create",
          kind: "internal",
          attributes: {
            component: "Daytona",
            method: "create",
            "http.response.status_code": 200,
          },
          scope: {
            name: "rawtree-daytona-test",
          },
        },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.duration_ms).toEqual(expect.any(Number));
      expect(rows[0]?.trace_id).toEqual(expect.any(String));
      expect(rows[0]?.span_id).toEqual(expect.any(String));
    } finally {
      await rawtree.close().catch(() => undefined);
      expect(process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT).toBe(previousEndpoint);
    }
  });
});
