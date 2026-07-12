import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { generateText } from "ai";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { RawTree, RawTreeError, type QueryResponse } from "../packages/sdk/src/index.js";
import {
  aiSdkIntegration,
  daytonaIntegration,
  initRawTree,
  RawTreeTraceExporter,
  registerOTel,
  shutdownRawTreeTracerProvider,
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

function firstOtlpExport(fetchMock: ReturnType<typeof vi.fn>) {
  return JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
}

function firstOtlpSpan(fetchMock: ReturnType<typeof vi.fn>) {
  return firstOtlpExport(fetchMock).resourceSpans[0].scopeSpans[0].spans[0];
}

function firstOtlpResource(fetchMock: ReturnType<typeof vi.fn>) {
  return firstOtlpExport(fetchMock).resourceSpans[0].resource;
}

const DAYTONA_OTEL_ENV_KEYS = [
  "DAYTONA_OTEL_ENABLED",
  "DAYTONA_EXPERIMENTAL_OTEL_ENABLED",
] as const;

function snapshotEnv(keys: readonly string[]): Map<string, string | undefined> {
  return new Map(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot: Map<string, string | undefined>): void {
  for (const [key, value] of snapshot) {
    if (value === undefined) {
      delete process.env[key];
      continue;
    }

    process.env[key] = value;
  }
}

function clearEnv(keys: readonly string[]): void {
  for (const key of keys) {
    delete process.env[key];
  }
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
    expect((headers as Headers).get("User-Agent")).toBe("rawtree-sdk-typescript/0.1.1");
  });

  it("supports overriding the user agent", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ meta: [], data: [], rows: 0, statistics: {} }),
    );
    const rawtree = new RawTree({
      apiKey: "rw_test",
      fetch: fetchMock,
      userAgent: "my-service/1.0.0",
    });

    await rawtree.query("SELECT 1");

    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get("User-Agent")).toBe("my-service/1.0.0");
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

  it("inserts with a transform", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ inserted: 1 }));
    const rawtree = new RawTree({
      apiKey: "rw_test",
      baseUrl: "https://example.com/",
      fetch: fetchMock,
    });

    await rawtree.insert("traces", { resourceSpans: [] }, {
      transform: "otlp-traces",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/v1/tables/traces?transform=otlp-traces",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ resourceSpans: [] }),
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

    const exportBody = firstOtlpExport(fetchMock);
    const otlpSpan = firstOtlpSpan(fetchMock);
    const otlpResource = firstOtlpResource(fetchMock);

    expect(fetchMock.mock.calls[0]?.[0])
      .toBe("https://api.rawtree.com/v1/tables/traces?transform=otlp-traces");
    expect(exportBody.resourceSpans).toHaveLength(1);
    expect(otlpSpan).toMatchObject({
      name: "GET /api/chat",
      kind: 1,
      status: {
        code: SpanStatusCode.OK,
      },
      attributes: [
        {
          key: "http.route",
          value: { stringValue: "/api/chat" },
        },
        {
          key: "app.tenant",
          value: { stringValue: "team_123" },
        },
      ],
    });
    expect(otlpResource).toMatchObject({
      attributes: [
        {
          key: "service.name",
          value: { stringValue: "api" },
        },
      ],
    });
    expect(exportBody.resourceSpans[0].scopeSpans[0].scope.name)
      .toBe("rawtree-register-otel-test");
    expect(otlpSpan.traceId).toEqual(expect.any(String));
    expect(otlpSpan.spanId).toEqual(expect.any(String));
    expect(otlpSpan.startTimeUnixNano).toEqual(expect.any(String));
    expect(otlpSpan.endTimeUnixNano).toEqual(expect.any(String));
  });

  it("flushes pending spans when provider unregister is disabled", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ inserted: 1 }));
    const otel = registerOTel({
      serviceName: "api",
      unregisterOnShutdown: false,
      apiKey: "rw_test",
      fetch: fetchMock,
      batchSpanProcessorOptions: {
        scheduledDelayMillis: 60_000,
      },
    });

    try {
      const span = trace
        .getTracer("rawtree-register-otel-flush-test")
        .startSpan("buffered span");
      span.end();

      await otel.shutdown();
    } finally {
      await shutdownRawTreeTracerProvider();
    }

    expect(fetchMock.mock.calls[0]?.[0])
      .toBe("https://api.rawtree.com/v1/tables/traces?transform=otlp-traces");
    expect(firstOtlpSpan(fetchMock)).toMatchObject({
      name: "buffered span",
    });
  });

  it("rejects async OpenTelemetry integration setup", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ inserted: 1 }));
    const asyncIntegration = {
      name: "async-integration",
      setupOtel: () => Promise.reject(new Error("setup failed")),
    };

    try {
      expect(() => registerOTel({
        serviceName: "api",
        spanProcessor: "simple",
        apiKey: "rw_test",
        fetch: fetchMock,
        integrations: [
          asyncIntegration as never,
        ],
      })).toThrow("OpenTelemetry integrations must set up synchronously");
    } finally {
      await shutdownRawTreeTracerProvider();
    }
  });

  it("does not close a shared exporter after a duplicate registration fails", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ inserted: 1 }));
    const exporter = new RawTreeTraceExporter({
      apiKey: "rw_test",
      fetch: fetchMock,
    });
    const otel = registerOTel({
      serviceName: "api",
      exporter,
      spanProcessor: "simple",
    });

    try {
      expect(() => registerOTel({
        serviceName: "api",
        exporter,
        spanProcessor: "simple",
      })).toThrow("already registered");

      const span = trace
        .getTracer("rawtree-register-otel-shared-exporter-test")
        .startSpan("after failed duplicate registration");
      span.end();

      await otel.shutdown();
    } finally {
      await otel.shutdown().catch(() => undefined);
    }

    expect(fetchMock.mock.calls[0]?.[0])
      .toBe("https://api.rawtree.com/v1/tables/traces?transform=otlp-traces");
    expect(firstOtlpSpan(fetchMock)).toMatchObject({
      name: "after failed duplicate registration",
    });
  });

  it("captures Daytona spans through registerOTel integration", async () => {
    const envSnapshot = snapshotEnv(DAYTONA_OTEL_ENV_KEYS);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ inserted: 1 }));
    let otel: ReturnType<typeof registerOTel> | undefined;

    process.env.DAYTONA_OTEL_ENABLED = "true";
    process.env.DAYTONA_EXPERIMENTAL_OTEL_ENABLED = "true";

    try {
      otel = registerOTel({
        apiKey: "rw_test",
        baseUrl: "https://rawtree.internal",
        serviceName: "api",
        spanProcessor: "simple",
        fetch: fetchMock,
        integrations: [
          daytonaIntegration(),
        ],
      });

      expect(process.env.DAYTONA_OTEL_ENABLED).toBe("false");
      expect(process.env.DAYTONA_EXPERIMENTAL_OTEL_ENABLED).toBe("false");

      const span = trace
        .getTracer("rawtree-daytona-integration-test")
        .startSpan("Daytona.create", {
          attributes: {
            "daytona.operation": "create",
            "sandbox.language": "typescript",
          },
        });
      span.end();

      await otel.shutdown();

      expect(process.env.DAYTONA_OTEL_ENABLED).toBe("true");
      expect(process.env.DAYTONA_EXPERIMENTAL_OTEL_ENABLED).toBe("true");
      expect(fetchMock.mock.calls[0]?.[0])
        .toBe("https://rawtree.internal/v1/tables/traces?transform=otlp-traces");
      expect(firstOtlpSpan(fetchMock)).toMatchObject({
        name: "Daytona.create",
        attributes: expect.arrayContaining([
          {
            key: "daytona.operation",
            value: { stringValue: "create" },
          },
          {
            key: "sandbox.language",
            value: { stringValue: "typescript" },
          },
        ]),
      });
      expect(firstOtlpResource(fetchMock)).toMatchObject({
        attributes: [
          {
            key: "service.name",
            value: { stringValue: "api" },
          },
        ],
      });
    } finally {
      await otel?.shutdown().catch(() => undefined);
      restoreEnv(envSnapshot);
    }
  });

  it("restores absent Daytona OTEL guard environment on shutdown", async () => {
    const envSnapshot = snapshotEnv(DAYTONA_OTEL_ENV_KEYS);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ inserted: 1 }));
    let otel: ReturnType<typeof registerOTel> | undefined;

    clearEnv(DAYTONA_OTEL_ENV_KEYS);

    try {
      otel = registerOTel({
        apiKey: "rw_test",
        serviceName: "api",
        spanProcessor: "simple",
        fetch: fetchMock,
        integrations: [
          daytonaIntegration(),
        ],
      });

      expect(process.env.DAYTONA_OTEL_ENABLED).toBe("false");
      expect(process.env.DAYTONA_EXPERIMENTAL_OTEL_ENABLED).toBe("false");

      await otel.shutdown();

      expect(process.env.DAYTONA_OTEL_ENABLED).toBeUndefined();
      expect(process.env.DAYTONA_EXPERIMENTAL_OTEL_ENABLED).toBeUndefined();
    } finally {
      await otel?.shutdown().catch(() => undefined);
      restoreEnv(envSnapshot);
    }
  });

  it("shuts down the provider when an integration teardown fails", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ inserted: 1 }));
    const otel = registerOTel({
      serviceName: "api",
      spanProcessor: "simple",
      apiKey: "rw_test",
      fetch: fetchMock,
      integrations: [
        {
          name: "bad-teardown",
          setupOtel: () => () => {
            throw new Error("teardown failed");
          },
        },
      ],
    });

    await expect(otel.shutdown()).rejects.toThrow("teardown failed");

    const next = registerOTel({
      serviceName: "api",
      spanProcessor: "simple",
      apiKey: "rw_test",
      fetch: fetchMock,
    });
    await next.shutdown();
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

    expect(monitorFetchMock).not.toHaveBeenCalled();
    expect(traceFetchMock.mock.calls[0]?.[0])
      .toBe("https://api.rawtree.com/v1/tables/traces?transform=otlp-traces");
    expect(firstOtlpSpan(traceFetchMock)).toMatchObject({
      name: "after monitoring close",
    });
    expect(firstOtlpResource(traceFetchMock)).toMatchObject({
      attributes: [
        {
          key: "service.name",
          value: {
            stringValue: "api",
          },
        },
      ],
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
