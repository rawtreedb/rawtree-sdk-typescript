import * as ai from "ai";
import { type LanguageModelMiddleware } from "ai";
import {
  type RawTreeIntegration,
  type RawTreeIntegrationRegistry,
  type RawTreeMonitoringClient,
  serializeError,
} from "../monitoring.js";

export type AISDKLanguageModel = Parameters<typeof ai.wrapLanguageModel>[0]["model"];

export interface RawTreeAISDKIntegrationOptions {
  captureInputs?: boolean;
  captureOutputs?: boolean;
  captureToolCalls?: boolean;
  captureRequestBody?: boolean;
  captureResponseBody?: boolean;
  captureProviderMetadata?: boolean;
  eventPrefix?: string;
  maxCapturedContentLength?: number;
}

export interface RawTreeAISDKIntegrationClient {
  middleware: (options?: RawTreeAISDKIntegrationOptions) => LanguageModelMiddleware;
  wrapModel: (
    model: AISDKLanguageModel,
    options?: RawTreeAISDKIntegrationOptions,
  ) => AISDKLanguageModel;
}

declare module "../monitoring.js" {
  interface RawTreeIntegrationRegistry {
    aiSdk: RawTreeAISDKIntegrationClient;
  }
}

const DEFAULT_EVENT_PREFIX = "ai.sdk";
const DEFAULT_MAX_CAPTURED_CONTENT_LENGTH = 8_000;
const activeTelemetryClients = new Map<RawTreeMonitoringClient, RawTreeAISDKIntegrationOptions>();
let isTelemetryDispatcherRegistered = false;

type AISDKTelemetryDispatcher = Record<string, (event: unknown) => void>;

const telemetryDispatcher: AISDKTelemetryDispatcher = {
  onStart(event) {
    for (const [client, options] of activeTelemetryClients) {
      client.capture(eventName(options, "start"), summarizeTelemetryStart(event as unknown, options), {
        source: "ai-sdk",
      });
    }
  },

  onFinish(event) {
    for (const [client, options] of activeTelemetryClients) {
      const record = asRecord(event);

      client.capture(eventName(options, "generate"), summarizeTelemetryFinish(event, options), {
        source: "ai-sdk",
        status: record.finishReason === "error" ? "error" : "ok",
      });
    }
  },

  onEnd(event) {
    for (const [client, options] of activeTelemetryClients) {
      const record = asRecord(event);
      const suffix = record.operationId === "ai.harness" ? "harness" : "generate";

      client.capture(eventName(options, suffix), summarizeTelemetryEnd(event, options), {
        source: "ai-sdk",
        status: record.finishReason === "error" ? "error" : "ok",
      });
    }
  },

  onLanguageModelCallStart(event) {
    for (const [client, options] of activeTelemetryClients) {
      client.capture(eventName(options, "model_call.start"), summarizeTelemetryModelCallStart(event, options), {
        source: "ai-sdk",
      });
    }
  },

  onLanguageModelCallEnd(event) {
    for (const [client, options] of activeTelemetryClients) {
      const record = asRecord(event);

      client.capture(eventName(options, "model_call.end"), summarizeTelemetryModelCallEnd(event, options), {
        source: "ai-sdk",
        status: record.finishReason === "error" ? "error" : "ok",
      });
    }
  },

  onToolCallFinish(event) {
    for (const [client, options] of activeTelemetryClients) {
      if (options.captureToolCalls === false) {
        continue;
      }

      const record = asRecord(event);

      client.capture(eventName(options, "tool_call"), summarizeTelemetryToolCall(event, options), {
        source: "ai-sdk",
        status: record.success ? "ok" : "error",
        durationMs: typeof record.durationMs === "number" ? record.durationMs : undefined,
      });
    }
  },

  onToolExecutionStart(event) {
    for (const [client, options] of activeTelemetryClients) {
      if (options.captureToolCalls === false) {
        continue;
      }

      client.capture(eventName(options, "tool_call.start"), summarizeTelemetryToolExecutionStart(event, options), {
        source: "ai-sdk",
      });
    }
  },

  onToolExecutionEnd(event) {
    for (const [client, options] of activeTelemetryClients) {
      if (options.captureToolCalls === false) {
        continue;
      }

      const record = asRecord(event);
      const output = asRecord(record.toolOutput);

      client.capture(eventName(options, "tool_call"), summarizeTelemetryToolExecutionEnd(event, options), {
        source: "ai-sdk",
        status: output.type === "error" || output.type === "tool-error" ? "error" : "ok",
        durationMs: typeof record.toolExecutionMs === "number" ? record.toolExecutionMs : undefined,
      });
    }
  },

  onError(error) {
    for (const [client] of activeTelemetryClients) {
      client.captureException(error, { operation: "ai-sdk" }, { source: "ai-sdk" });
    }
  },
};

export function aiSdkIntegration(
  options: RawTreeAISDKIntegrationOptions = {},
): RawTreeIntegration {
  return {
    name: "ai-sdk",
    setup(client) {
      registerAISDKTelemetryDispatcher();
      activeTelemetryClients.set(client, options);

      client.registerIntegrationUtility("aiSdk", {
        middleware: (overrideOptions) => rawtreeAISDKMiddleware(client, {
          ...options,
          ...overrideOptions,
        }),
        wrapModel: (model, overrideOptions) => wrapAISDKModel(model, client, {
          ...options,
          ...overrideOptions,
        }),
      } satisfies RawTreeIntegrationRegistry["aiSdk"]);

      return () => {
        activeTelemetryClients.delete(client);
      };
    },
  };
}

function registerAISDKTelemetryDispatcher(): void {
  if (isTelemetryDispatcherRegistered) {
    return;
  }

  const telemetryApi = ai as unknown as {
    registerTelemetryIntegration?: (integration: unknown) => void;
    registerTelemetry?: (...integrations: unknown[]) => void;
  };

  if (telemetryApi.registerTelemetry) {
    telemetryApi.registerTelemetry(telemetryDispatcher);
  } else if (telemetryApi.registerTelemetryIntegration) {
    telemetryApi.registerTelemetryIntegration(telemetryDispatcher);
  } else {
    throw new TypeError("RawTree AI SDK integration requires AI SDK telemetry support.");
  }

  isTelemetryDispatcherRegistered = true;
}

export function rawtreeAISDKMiddleware(
  client: RawTreeMonitoringClient,
  options: RawTreeAISDKIntegrationOptions = {},
): LanguageModelMiddleware {
  return {
    specificationVersion: "v3",

    async wrapGenerate({ doGenerate, params, model }) {
      const startedAt = Date.now();
      const payload = buildCallPayload("generate", params, model, options);

      try {
        const result = await doGenerate();

        client.capture(eventName(options, "generate"), {
          ...payload,
          result: summarizeGenerateResult(result, options),
        }, {
          source: "ai-sdk",
          status: "ok",
          durationMs: Date.now() - startedAt,
        });

        return result;
      } catch (error) {
        client.captureException(error, {
          ...payload,
          operation: "generate",
        }, {
          source: "ai-sdk",
          durationMs: Date.now() - startedAt,
        });
        throw error;
      }
    },

    async wrapStream({ doStream, params, model }) {
      const startedAt = Date.now();
      const payload = buildCallPayload("stream", params, model, options);

      try {
        const result = await doStream();

        return {
          ...result,
          stream: instrumentStream(result.stream, {
            client,
            startedAt,
            payload: {
              ...payload,
              response: summarizeStreamResponse(result.response),
            },
            options,
          }),
        };
      } catch (error) {
        client.captureException(error, {
          ...payload,
          operation: "stream",
        }, {
          source: "ai-sdk",
          durationMs: Date.now() - startedAt,
        });
        throw error;
      }
    },
  };
}

export function wrapAISDKModel(
  model: AISDKLanguageModel,
  client: RawTreeMonitoringClient,
  options: RawTreeAISDKIntegrationOptions = {},
): AISDKLanguageModel {
  return ai.wrapLanguageModel({
    model,
    middleware: rawtreeAISDKMiddleware(client, options),
  });
}

type GenerateResult = Awaited<ReturnType<AISDKLanguageModel["doGenerate"]>>;
type CallOptions = Parameters<AISDKLanguageModel["doGenerate"]>[0];
type StreamResult = Awaited<ReturnType<AISDKLanguageModel["doStream"]>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer Part> ? Part : never;

interface StreamInstrumentationOptions {
  client: RawTreeMonitoringClient;
  startedAt: number;
  payload: Record<string, unknown>;
  options: RawTreeAISDKIntegrationOptions;
}

function instrumentStream(
  stream: ReadableStream<StreamPart>,
  instrumentation: StreamInstrumentationOptions,
): ReadableStream<StreamPart> {
  const reader = stream.getReader();
  const summary = createStreamSummary();

  return new ReadableStream<StreamPart>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();

        if (done) {
          instrumentation.client.capture(eventName(instrumentation.options, "stream"), {
            ...instrumentation.payload,
            result: summary,
          }, {
            source: "ai-sdk",
            status: summary.errors.length > 0 ? "error" : "ok",
            durationMs: Date.now() - instrumentation.startedAt,
          });
          controller.close();
          return;
        }

        summarizeStreamPart(summary, value, instrumentation.options);
        controller.enqueue(value);
      } catch (error) {
        instrumentation.client.captureException(error, {
          ...instrumentation.payload,
          operation: "stream",
          result: summary,
        }, {
          source: "ai-sdk",
          durationMs: Date.now() - instrumentation.startedAt,
        });
        controller.error(error);
      }
    },

    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
}

function buildCallPayload(
  operation: "generate" | "stream",
  params: CallOptions,
  model: AISDKLanguageModel,
  options: RawTreeAISDKIntegrationOptions,
): Record<string, unknown> {
  return {
    operation,
    provider: model.provider,
    model: model.modelId,
    settings: {
      maxOutputTokens: params.maxOutputTokens,
      temperature: params.temperature,
      stopSequences: params.stopSequences,
      topP: params.topP,
      topK: params.topK,
      presencePenalty: params.presencePenalty,
      frequencyPenalty: params.frequencyPenalty,
      responseFormat: params.responseFormat,
      seed: params.seed,
      toolChoice: params.toolChoice,
    },
    tools: summarizeTools(params.tools, options),
    prompt: options.captureInputs ? params.prompt : summarizePrompt(params.prompt),
  };
}

function summarizeGenerateResult(
  result: GenerateResult,
  options: RawTreeAISDKIntegrationOptions,
): Record<string, unknown> {
  return {
    finishReason: result.finishReason,
    usage: result.usage,
    warnings: result.warnings,
    content: summarizeContent(result.content, options),
    providerMetadata: options.captureProviderMetadata ? result.providerMetadata : undefined,
    request: options.captureRequestBody ? result.request : undefined,
    response: summarizeGenerateResponse(result.response, options),
  };
}

function summarizeTelemetryStart(
  event: unknown,
  options: RawTreeAISDKIntegrationOptions,
): Record<string, unknown> {
  const record = asRecord(event);
  const model = getEventModel(record);

  return {
    operation: record.operationId ?? "start",
    callId: record.callId,
    functionId: record.functionId,
    metadata: record.metadata,
    provider: model.provider,
    model: model.model,
    settings: {
      maxOutputTokens: record.maxOutputTokens,
      temperature: record.temperature,
      stopSequences: record.stopSequences,
      topP: record.topP,
      topK: record.topK,
      presencePenalty: record.presencePenalty,
      frequencyPenalty: record.frequencyPenalty,
      seed: record.seed,
      maxRetries: record.maxRetries,
      toolChoice: record.toolChoice,
    },
    tools: summarizeToolSet(record.tools, options),
    instructions: summarizeInput(record.instructions, options),
    system: summarizeInput(record.system, options),
    prompt: summarizeInput(record.prompt, options),
    messages: summarizeInput(record.messages, options),
    runtimeContext: summarizeInput(record.runtimeContext, options),
  };
}

function summarizeTelemetryFinish(
  event: unknown,
  options: RawTreeAISDKIntegrationOptions,
): Record<string, unknown> {
  const record = asRecord(event);
  const model = getEventModel(record);
  const steps = asArray(record.steps);

  return {
    operation: "generate",
    callId: record.callId,
    functionId: record.functionId,
    metadata: record.metadata,
    provider: model.provider,
    model: model.model,
    finishReason: record.finishReason,
    rawFinishReason: record.rawFinishReason,
    usage: record.usage,
    totalUsage: record.totalUsage,
    warnings: record.warnings,
    steps: steps.map((step) => summarizeTelemetryStep(step, options)),
    result: summarizeTelemetryStep(event, options),
  };
}

function summarizeTelemetryEnd(
  event: unknown,
  options: RawTreeAISDKIntegrationOptions,
): Record<string, unknown> {
  const record = asRecord(event);
  const model = getEventModel(record);
  const finalStep = record.finalStep ?? event;
  const steps = asArray(record.steps);

  return {
    operation: record.operationId ?? "end",
    callId: record.callId,
    provider: model.provider,
    model: model.model,
    finishReason: record.finishReason,
    rawFinishReason: record.rawFinishReason,
    usage: record.usage,
    totalUsage: record.totalUsage,
    warnings: record.warnings,
    content: summarizeContent(asArray(record.content), options),
    text: summarizeText(typeof record.text === "string" ? record.text : undefined, options),
    toolCalls: options.captureToolCalls === false
      ? { count: asArray(record.toolCalls).length }
      : asArray(record.toolCalls).map((toolCall) => summarizeTelemetryToolCallValue(toolCall, options)),
    toolResults: options.captureToolCalls === false
      ? { count: asArray(record.toolResults).length }
      : asArray(record.toolResults).map((toolResult) => summarizeTelemetryToolResultValue(toolResult, options)),
    steps: steps.map((step) => summarizeTelemetryStep(step, options)),
    result: summarizeTelemetryStep(finalStep, options),
    runtimeContext: summarizeInput(record.runtimeContext, options),
    response: isRecord(record.response)
      ? summarizeTelemetryResponse(record.response, options)
      : undefined,
  };
}

function summarizeTelemetryStep(
  step: unknown,
  options: RawTreeAISDKIntegrationOptions,
): Record<string, unknown> {
  const record = asRecord(step);
  const model = getEventModel(record);
  const toolCalls = asArray(record.toolCalls);
  const toolResults = asArray(record.toolResults);

  return {
    stepNumber: record.stepNumber,
    provider: model.provider,
    model: model.model,
    finishReason: record.finishReason,
    rawFinishReason: record.rawFinishReason,
    usage: record.usage,
    warnings: record.warnings,
    text: summarizeText(typeof record.text === "string" ? record.text : undefined, options),
    reasoningText: summarizeText(
      typeof record.reasoningText === "string" ? record.reasoningText : undefined,
      options,
    ),
    content: summarizeContent(asArray(record.content), options),
    toolCalls: options.captureToolCalls === false
      ? { count: toolCalls.length }
      : toolCalls.map((toolCall) => summarizeTelemetryToolCallValue(toolCall, options)),
    toolResults: options.captureToolCalls === false
      ? { count: toolResults.length }
      : toolResults.map((toolResult) => summarizeTelemetryToolResultValue(toolResult, options)),
    sources: record.sources,
    files: asArray(record.files).map((file) => ({
      mediaType: isRecord(file) ? file.mediaType : undefined,
    })),
    request: options.captureRequestBody ? record.request : undefined,
    response: isRecord(record.response)
      ? summarizeTelemetryResponse(record.response, options)
      : undefined,
    providerMetadata: options.captureProviderMetadata ? record.providerMetadata : undefined,
  };
}

function summarizeTelemetryToolCall(
  event: unknown,
  options: RawTreeAISDKIntegrationOptions,
): Record<string, unknown> {
  const record = asRecord(event);
  const model = getEventModel(record);

  return {
    operation: "tool_call",
    callId: record.callId,
    functionId: record.functionId,
    metadata: record.metadata,
    stepNumber: record.stepNumber,
    provider: model.provider,
    model: model.model,
    toolCall: summarizeTelemetryToolCallValue(record.toolCall, options),
    success: record.success,
    output: record.success && options.captureOutputs ? record.output : undefined,
    error: record.success ? undefined : serializeError(record.error),
  };
}

function summarizeTelemetryModelCallStart(
  event: unknown,
  options: RawTreeAISDKIntegrationOptions,
): Record<string, unknown> {
  const record = asRecord(event);
  const model = getEventModel(record);

  return {
    operation: "model_call.start",
    callId: record.callId,
    provider: model.provider,
    model: model.model,
    tools: summarizeToolSet(record.tools, options),
    messages: summarizeInput(record.messages, options),
  };
}

function summarizeTelemetryModelCallEnd(
  event: unknown,
  options: RawTreeAISDKIntegrationOptions,
): Record<string, unknown> {
  const record = asRecord(event);
  const model = getEventModel(record);

  return {
    operation: "model_call.end",
    callId: record.callId,
    provider: model.provider,
    model: model.model,
    finishReason: record.finishReason,
    usage: record.usage,
    responseId: record.responseId,
    content: summarizeContent(asArray(record.content), options),
    performance: record.performance,
  };
}

function summarizeTelemetryToolExecutionStart(
  event: unknown,
  options: RawTreeAISDKIntegrationOptions,
): Record<string, unknown> {
  const record = asRecord(event);

  return {
    operation: "tool_call.start",
    callId: record.callId,
    toolCall: summarizeTelemetryToolCallValue(record.toolCall, options),
    messages: summarizeInput(record.messages, options),
    toolContext: summarizeInput(record.toolContext, options),
  };
}

function summarizeTelemetryToolExecutionEnd(
  event: unknown,
  options: RawTreeAISDKIntegrationOptions,
): Record<string, unknown> {
  const record = asRecord(event);
  const output = asRecord(record.toolOutput);
  const success = output.type !== "error" && output.type !== "tool-error";

  return {
    operation: "tool_call",
    callId: record.callId,
    toolCall: summarizeTelemetryToolCallValue(record.toolCall, options),
    success,
    output: success && options.captureOutputs ? (output.output ?? output.result) : undefined,
    error: success ? undefined : serializeError(output.error),
    messages: summarizeInput(record.messages, options),
    toolContext: summarizeInput(record.toolContext, options),
  };
}

function summarizeTelemetryToolCallValue(
  toolCall: unknown,
  options: RawTreeAISDKIntegrationOptions,
): Record<string, unknown> {
  if (!isRecord(toolCall)) {
    return {};
  }

  return {
    toolCallId: toolCall.toolCallId,
    toolName: toolCall.toolName,
    type: toolCall.type,
    input: options.captureOutputs ? toolCall.input : undefined,
  };
}

function summarizeTelemetryToolResultValue(
  toolResult: unknown,
  options: RawTreeAISDKIntegrationOptions,
): Record<string, unknown> {
  if (!isRecord(toolResult)) {
    return {};
  }

  return {
    toolCallId: toolResult.toolCallId,
    toolName: toolResult.toolName,
    type: toolResult.type,
    output: options.captureOutputs ? toolResult.output : undefined,
    error: options.captureOutputs ? toolResult.error : undefined,
  };
}

function summarizeToolSet(
  tools: unknown,
  options: RawTreeAISDKIntegrationOptions,
): unknown {
  if (!isRecord(tools)) {
    return tools === undefined ? undefined : { type: typeof tools };
  }

  const names = Object.keys(tools);

  if (options.captureToolCalls === false) {
    return { count: names.length, names };
  }

  return names.map((name) => ({
    name,
    type: isRecord(tools[name]) ? tools[name].type : undefined,
    description: isRecord(tools[name]) ? tools[name].description : undefined,
  }));
}

function summarizeInput(
  input: unknown,
  options: RawTreeAISDKIntegrationOptions,
): unknown {
  if (options.captureInputs) {
    return input;
  }

  if (input === undefined) {
    return undefined;
  }

  if (typeof input === "string") {
    return { type: "text", length: input.length };
  }

  if (Array.isArray(input)) {
    return {
      type: "array",
      count: input.length,
      roles: input.map((item) => isRecord(item) ? item.role : undefined),
    };
  }

  if (isRecord(input)) {
    return {
      type: "object",
      keys: Object.keys(input),
    };
  }

  return { type: typeof input };
}

function summarizeTelemetryResponse(
  response: Record<string, unknown>,
  options: RawTreeAISDKIntegrationOptions,
): Record<string, unknown> {
  if (options.captureResponseBody) {
    return response;
  }

  const { body: _body, headers: _headers, messages, ...metadata } = response;

  return {
    ...metadata,
    messageCount: Array.isArray(messages) ? messages.length : undefined,
  };
}

function summarizeText(
  text: string | undefined,
  options: RawTreeAISDKIntegrationOptions,
): Record<string, unknown> | undefined {
  if (text === undefined) {
    return undefined;
  }

  return {
    length: text.length,
    text: options.captureOutputs ? truncate(text, options) : undefined,
  };
}

function getEventModel(record: Record<string, unknown>): { provider?: unknown; model?: unknown } {
  const model = asRecord(record.model);
  const response = asRecord(record.response);

  return {
    provider: model.provider ?? record.provider,
    model: model.modelId ?? record.modelId ?? response.modelId,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function summarizeGenerateResponse(
  response: GenerateResult["response"],
  options: RawTreeAISDKIntegrationOptions,
): unknown {
  if (!response) {
    return undefined;
  }

  if (options.captureResponseBody) {
    return response;
  }

  const { body: _body, headers: _headers, ...metadata } = response;
  return metadata;
}

function summarizeStreamResponse(response: StreamResult["response"]): unknown {
  if (!response) {
    return undefined;
  }

  const { headers: _headers, ...metadata } = response;
  return metadata;
}

function summarizePrompt(prompt: CallOptions["prompt"]): Record<string, unknown> {
  return {
    messageCount: prompt.length,
    roles: prompt.map((message) => message.role),
    content: prompt.map((message) => {
      if (typeof message.content === "string") {
        return { role: message.role, type: "text", length: message.content.length };
      }

      return {
        role: message.role,
        parts: message.content.map((part) => summarizePart(part)),
      };
    }),
  };
}

function summarizeTools(
  tools: CallOptions["tools"],
  options: RawTreeAISDKIntegrationOptions,
): unknown {
  if (!tools) {
    return undefined;
  }

  if (options.captureToolCalls === false) {
    return { count: tools.length };
  }

  return tools.map((tool) => {
    const record = tool as Record<string, unknown>;

    return {
      type: record.type,
      name: record.name,
      description: record.description,
    };
  });
}

function summarizeContent(
  content: unknown[],
  options: RawTreeAISDKIntegrationOptions,
): unknown[] {
  return content.map((part) => summarizePart(part, options));
}

function summarizePart(
  part: unknown,
  options: RawTreeAISDKIntegrationOptions = {},
): Record<string, unknown> {
  if (!isRecord(part) || typeof part.type !== "string") {
    return { type: "unknown" };
  }

  switch (part.type) {
    case "text":
    case "reasoning": {
      const text = typeof part.text === "string" ? part.text : "";
      return {
        type: part.type,
        length: text.length,
        text: options.captureOutputs ? truncate(text, options) : undefined,
      };
    }
    case "file":
      return {
        type: "file",
        filename: part.filename,
        mediaType: part.mediaType ?? (isRecord(part.file) ? part.file.mediaType : undefined),
      };
    case "tool-call":
      return {
        type: "tool-call",
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        providerExecuted: part.providerExecuted,
        dynamic: part.dynamic,
        input: options.captureToolCalls === false || !options.captureOutputs
          ? undefined
          : part.input,
      };
    case "tool-result":
      return {
        type: "tool-result",
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        isError: part.isError,
        preliminary: part.preliminary,
        dynamic: part.dynamic,
        result: options.captureToolCalls === false || !options.captureOutputs
          ? undefined
          : ("result" in part ? part.result : part.output),
      };
    case "source":
      return {
        type: "source",
        sourceType: part.sourceType,
        id: part.id,
        url: part.url,
        title: part.title,
      };
    default:
      return { type: part.type };
  }
}

function createStreamSummary(): {
  finishReason?: unknown;
  usage?: unknown;
  textLength: number;
  reasoningLength: number;
  text?: string;
  reasoning?: string;
  toolCalls: Array<Record<string, unknown>>;
  toolResults: Array<Record<string, unknown>>;
  errors: Array<ReturnType<typeof serializeError>>;
} {
  return {
    textLength: 0,
    reasoningLength: 0,
    toolCalls: [],
    toolResults: [],
    errors: [],
  };
}

function summarizeStreamPart(
  summary: ReturnType<typeof createStreamSummary>,
  part: StreamPart,
  options: RawTreeAISDKIntegrationOptions,
): void {
  if (!isRecord(part) || typeof part.type !== "string") {
    return;
  }

  switch (part.type) {
    case "text-delta": {
      const delta = typeof part.delta === "string" ? part.delta : "";
      summary.textLength += delta.length;

      if (options.captureOutputs) {
        summary.text = appendLimited(summary.text, delta, options);
      }
      break;
    }
    case "reasoning-delta": {
      const delta = typeof part.delta === "string" ? part.delta : "";
      summary.reasoningLength += delta.length;

      if (options.captureOutputs) {
        summary.reasoning = appendLimited(summary.reasoning, delta, options);
      }
      break;
    }
    case "tool-call":
      if (options.captureToolCalls !== false) {
        summary.toolCalls.push(summarizePart(part, options));
      }
      break;
    case "tool-result":
      if (options.captureToolCalls !== false) {
        summary.toolResults.push(summarizePart(part, options));
      }
      break;
    case "finish":
      summary.finishReason = part.finishReason;
      summary.usage = part.usage;
      break;
    case "error":
      summary.errors.push(serializeError(part.error));
      break;
  }
}

function eventName(options: RawTreeAISDKIntegrationOptions, suffix: string): string {
  return `${options.eventPrefix ?? DEFAULT_EVENT_PREFIX}.${suffix}`;
}

function truncate(text: string, options: RawTreeAISDKIntegrationOptions): string {
  return text.slice(0, options.maxCapturedContentLength ?? DEFAULT_MAX_CAPTURED_CONTENT_LENGTH);
}

function appendLimited(
  current: string | undefined,
  delta: string,
  options: RawTreeAISDKIntegrationOptions,
): string {
  return truncate(`${current ?? ""}${delta}`, options);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
