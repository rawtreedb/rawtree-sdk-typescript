import {
  context,
  SpanStatusCode,
  trace,
  type Attributes,
  type Span as ApiSpan,
} from "@opentelemetry/api";
import type {
  ReadableSpan,
  Span,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
  type RawTreeIntegration,
  type RawTreeIntegrationRegistry,
  type RawTreeMonitoringClient,
} from "../monitoring.js";
import {
  attributesToRecord,
  compactRecord,
  getOtelSpanCaptureOptions,
  normalizeValue,
  registerRawTreeSpanProcessor,
  summarizeOtelSpan,
} from "./otel.js";

export interface RawTreeAISDKIntegrationOptions {
  eventName?: string;
  eventPrefix?: string;
  captureInputs?: boolean;
  captureOutputs?: boolean;
  captureToolCalls?: boolean;
  captureProviderMetadata?: boolean;
  captureResource?: boolean;
  captureScope?: boolean;
  captureEvents?: boolean;
  captureLinks?: boolean;
  maxCapturedContentLength?: number;
  unregisterOnClose?: boolean;
  forceRegisterProvider?: boolean;
}

export interface RawTreeAISDKIntegrationClient {
  isEnabled: boolean;
  providerRegistered: boolean;
  capturedOperations: readonly string[];
}

declare module "../monitoring.js" {
  interface RawTreeIntegrationRegistry {
    aiSdk: RawTreeAISDKIntegrationClient;
  }
}

const DEFAULT_EVENT_PREFIX = "ai.sdk";
const DEFAULT_MAX_CAPTURED_CONTENT_LENGTH = 8_000;

const RAWTREE_ORIGIN_ATTRIBUTE = "rawtree.origin";
const RAWTREE_AI_ORIGINAL_NAME_ATTRIBUTE = "rawtree.ai.original_name";
const RAWTREE_AI_OPERATION_ATTRIBUTE = "rawtree.ai.operation";
const RAWTREE_AI_PIPELINE_NAME_ATTRIBUTE = "rawtree.ai.pipeline_name";
const RAWTREE_AI_ORIGIN = "auto.ai_sdk.otel";

const AI_OPERATION_ID_ATTRIBUTE = "ai.operationId";
const AI_MODEL_PROVIDER_ATTRIBUTE = "ai.model.provider";
const AI_MODEL_ID_ATTRIBUTE = "ai.model.id";
const AI_RESPONSE_MODEL_ATTRIBUTE = "ai.response.model";
const AI_TELEMETRY_FUNCTION_ID_ATTRIBUTE = "ai.telemetry.functionId";
const AI_TOOL_CALL_ID_ATTRIBUTE = "ai.toolCall.id";
const AI_TOOL_CALL_NAME_ATTRIBUTE = "ai.toolCall.name";

const GEN_AI_OPERATION_NAME_ATTRIBUTE = "gen_ai.operation.name";
const GEN_AI_REQUEST_MODEL_ATTRIBUTE = "gen_ai.request.model";
const GEN_AI_RESPONSE_MODEL_ATTRIBUTE = "gen_ai.response.model";
const GEN_AI_TOOL_CALL_ID_ATTRIBUTE = "gen_ai.tool.call.id";
const GEN_AI_TOOL_NAME_ATTRIBUTE = "gen_ai.tool.name";
const GEN_AI_TOOL_TYPE_ATTRIBUTE = "gen_ai.tool.type";

const SPAN_TO_OPERATION_NAME = new Map<string, string>([
  ["ai.generateText", "invoke_agent"],
  ["ai.streamText", "invoke_agent"],
  ["ai.generateObject", "invoke_agent"],
  ["ai.streamObject", "invoke_agent"],
  ["ai.generateText.doGenerate", "generate_content"],
  ["ai.streamText.doStream", "generate_content"],
  ["ai.generateObject.doGenerate", "generate_content"],
  ["ai.streamObject.doStream", "generate_content"],
  ["ai.embed.doEmbed", "embeddings"],
  ["ai.embedMany.doEmbed", "embeddings"],
  ["ai.rerank.doRerank", "rerank"],
  ["ai.toolCall", "execute_tool"],
]);

const CAPTURED_OPERATIONS = [...new Set(SPAN_TO_OPERATION_NAME.values())];
const bridgeTracer = trace.getTracer("rawtree.ai-sdk.telemetry");

let telemetryBridgeRegistrationCount = 0;
let isTelemetryBridgeRegistered = false;

declare global {
  var AI_SDK_TELEMETRY_INTEGRATIONS: unknown[] | undefined;
}

interface AISDKSpanClassification {
  isAISDKSpan: boolean;
  originalName: string;
  operationId?: string;
  operation?: string;
  pipelineName?: string;
}

export function aiSdkIntegration(
  options: RawTreeAISDKIntegrationOptions = {},
): RawTreeIntegration {
  return {
    name: "ai-sdk",
    setup(client) {
      const processor = new RawTreeAISDKSpanProcessor(client, options);
      const registration = registerRawTreeSpanProcessor(processor, options);
      const disableTelemetryBridge = registration.isEnabled
        ? enableAISDKTelemetryBridge()
        : undefined;

      client.registerIntegrationUtility("aiSdk", {
        isEnabled: registration.isEnabled,
        providerRegistered: registration.providerRegistered,
        capturedOperations: CAPTURED_OPERATIONS,
      } satisfies RawTreeIntegrationRegistry["aiSdk"]);

      return async () => {
        disableTelemetryBridge?.();
        await registration.teardown();
      };
    },
  };
}

class RawTreeAISDKSpanProcessor implements SpanProcessor {
  private isShutdown = false;

  constructor(
    private readonly client: RawTreeMonitoringClient,
    private readonly options: RawTreeAISDKIntegrationOptions,
  ) {}

  onStart(span: Span): void {
    if (this.isShutdown) {
      return;
    }

    const classification = classifyAISDKSpan(span.name, span.attributes);

    if (!this.shouldCapture(classification)) {
      return;
    }

    annotateAISDKSpan(span, classification);
  }

  onEnd(span: ReadableSpan): void {
    if (this.isShutdown) {
      return;
    }

    const classification = classifyAISDKSpan(span.name, span.attributes);

    if (!this.shouldCapture(classification)) {
      return;
    }

    const attributes = sanitizeAISDKAttributes(
      attributesToRecord(span.attributes) ?? {},
      this.options,
    );

    this.client.capture(getEventName(classification, this.options), compactRecord({
      ...summarizeOtelSpan(span, {
        captureResource: this.options.captureResource,
        captureScope: this.options.captureScope,
        captureEvents: this.options.captureEvents,
        captureLinks: this.options.captureLinks,
        attributes,
      }),
      originalName: classification.originalName,
      operation: classification.operation,
      operationId: classification.operationId,
      pipelineName: classification.pipelineName,
      provider: getStringAttribute(span.attributes, AI_MODEL_PROVIDER_ATTRIBUTE),
      model: getStringAttribute(span.attributes, AI_RESPONSE_MODEL_ATTRIBUTE)
        ?? getStringAttribute(span.attributes, AI_MODEL_ID_ATTRIBUTE),
      functionId: getStringAttribute(span.attributes, AI_TELEMETRY_FUNCTION_ID_ATTRIBUTE),
      toolName: getStringAttribute(span.attributes, GEN_AI_TOOL_NAME_ATTRIBUTE)
        ?? getStringAttribute(span.attributes, AI_TOOL_CALL_NAME_ATTRIBUTE),
      toolCallId: getStringAttribute(span.attributes, GEN_AI_TOOL_CALL_ID_ATTRIBUTE)
        ?? getStringAttribute(span.attributes, AI_TOOL_CALL_ID_ATTRIBUTE),
    }), {
      source: "ai-sdk",
      ...getOtelSpanCaptureOptions(span),
    });
  }

  async forceFlush(): Promise<void> {
    await this.client.flush();
  }

  async shutdown(): Promise<void> {
    this.isShutdown = true;
  }

  private shouldCapture(classification: AISDKSpanClassification): boolean {
    if (!classification.isAISDKSpan) {
      return false;
    }

    if (this.options.captureToolCalls === false && classification.operation === "execute_tool") {
      return false;
    }

    return true;
  }
}

const aiSdkTelemetryBridge = createAISDKTelemetryBridge();

function enableAISDKTelemetryBridge(): () => void {
  if (!isTelemetryBridgeRegistered) {
    globalThis.AI_SDK_TELEMETRY_INTEGRATIONS ??= [];
    globalThis.AI_SDK_TELEMETRY_INTEGRATIONS.push(aiSdkTelemetryBridge);
    isTelemetryBridgeRegistered = true;
  }

  telemetryBridgeRegistrationCount += 1;

  return () => {
    telemetryBridgeRegistrationCount = Math.max(0, telemetryBridgeRegistrationCount - 1);

    if (telemetryBridgeRegistrationCount > 0 || !isTelemetryBridgeRegistered) {
      return;
    }

    globalThis.AI_SDK_TELEMETRY_INTEGRATIONS = globalThis.AI_SDK_TELEMETRY_INTEGRATIONS
      ?.filter((integration) => integration !== aiSdkTelemetryBridge);
    isTelemetryBridgeRegistered = false;
  };
}

function createAISDKTelemetryBridge(): Record<string, unknown> {
  const operationSpans = new Map<string, ApiSpan>();
  const operationIds = new Map<string, string>();
  const modelSpans = new Map<string, ApiSpan>();
  const modelCallStarts = new Map<string, Record<string, unknown>>();
  const toolSpans = new Map<string, ApiSpan>();
  const toolExecutionStarts = new Map<string, Record<string, unknown>>();

  return {
    onStart(event: unknown) {
      if (!isTelemetryBridgeActive()) {
        return;
      }

      const record = asRecord(event);

      if (!isV7OperationStartEvent(record)) {
        return;
      }

      const callId = getStringAttribute(record, "callId");
      const operationId = getStringAttribute(record, "operationId");

      if (!callId || !operationId?.startsWith("ai.")) {
        return;
      }

      const span = bridgeTracer.startSpan(operationId, {
        attributes: createOperationStartAttributes(record),
      });

      operationSpans.set(callId, span);
      operationIds.set(callId, operationId);
    },

    onLanguageModelCallStart(event: unknown) {
      if (!isTelemetryBridgeActive()) {
        return;
      }

      const record = asRecord(event);
      const callId = getStringAttribute(record, "callId");

      if (callId) {
        modelCallStarts.set(callId, record);
      }
    },

    onLanguageModelCallEnd(event: unknown) {
      const record = asRecord(event);
      const callId = getStringAttribute(record, "callId");
      const span = callId ? modelSpans.get(callId) : undefined;

      if (!span || !callId) {
        return;
      }

      span.setAttributes(createLanguageModelCallEndAttributes(record));
      span.end();
      modelSpans.delete(callId);
      modelCallStarts.delete(callId);
    },

    onToolExecutionStart(event: unknown) {
      if (!isTelemetryBridgeActive()) {
        return;
      }

      const record = asRecord(event);
      const toolCall = asRecord(record.toolCall);
      const toolCallId = getStringAttribute(toolCall, "toolCallId");

      if (toolCallId) {
        toolExecutionStarts.set(toolCallId, record);
      }
    },

    onToolExecutionEnd(event: unknown) {
      const record = asRecord(event);
      const toolCall = asRecord(record.toolCall);
      const toolCallId = getStringAttribute(toolCall, "toolCallId");
      const span = toolCallId ? toolSpans.get(toolCallId) : undefined;

      if (!span || !toolCallId) {
        return;
      }

      span.setAttributes(createToolExecutionEndAttributes(record));

      if (isToolErrorOutput(record.toolOutput)) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: getToolErrorMessage(record.toolOutput),
        });
      }

      span.end();
      toolSpans.delete(toolCallId);
      toolExecutionStarts.delete(toolCallId);
    },

    onEnd(event: unknown) {
      const record = asRecord(event);
      const callId = getStringAttribute(record, "callId");
      const span = callId ? operationSpans.get(callId) : undefined;

      if (!span || !callId) {
        return;
      }

      span.setAttributes(createOperationEndAttributes(record));
      span.end();
      operationSpans.delete(callId);
      operationIds.delete(callId);
    },

    onAbort(event: unknown) {
      const record = asRecord(event);
      const callId = getStringAttribute(record, "callId");
      const span = callId ? operationSpans.get(callId) : undefined;

      if (!span || !callId) {
        return;
      }

      span.setStatus({ code: SpanStatusCode.ERROR, message: "aborted" });
      span.end();
      operationSpans.delete(callId);
      operationIds.delete(callId);
    },

    async executeLanguageModelCall<T>(options: {
      callId: string;
      execute: () => PromiseLike<T>;
    }): Promise<T> {
      if (!isTelemetryBridgeActive()) {
        return await options.execute();
      }

      const operationId = getLanguageModelCallOperationId(operationIds.get(options.callId));
      const parentSpan = operationSpans.get(options.callId);
      const parentContext = parentSpan ? trace.setSpan(context.active(), parentSpan) : context.active();
      const span = bridgeTracer.startSpan(operationId, {
        attributes: createLanguageModelCallStartAttributes(
          modelCallStarts.get(options.callId) ?? { callId: options.callId },
          operationId,
        ),
      }, parentContext);

      modelSpans.set(options.callId, span);

      try {
        return await context.with(trace.setSpan(parentContext, span), () => options.execute());
      } catch (error) {
        recordErrorOnSpan(span, error);
        span.end();
        modelSpans.delete(options.callId);
        modelCallStarts.delete(options.callId);
        throw error;
      }
    },

    async executeTool<T>(options: {
      callId: string;
      toolCallId: string;
      execute: () => PromiseLike<T>;
    }): Promise<T> {
      if (!isTelemetryBridgeActive()) {
        return await options.execute();
      }

      const parentSpan = operationSpans.get(options.callId);
      const parentContext = parentSpan ? trace.setSpan(context.active(), parentSpan) : context.active();
      const startEvent = toolExecutionStarts.get(options.toolCallId) ?? {
        callId: options.callId,
        toolCall: {
          toolCallId: options.toolCallId,
        },
      };
      const span = bridgeTracer.startSpan("ai.toolCall", {
        attributes: createToolExecutionStartAttributes(startEvent),
      }, parentContext);

      toolSpans.set(options.toolCallId, span);

      try {
        return await context.with(trace.setSpan(parentContext, span), () => options.execute());
      } catch (error) {
        recordErrorOnSpan(span, error);
        span.end();
        toolSpans.delete(options.toolCallId);
        toolExecutionStarts.delete(options.toolCallId);
        throw error;
      }
    },
  };
}

function classifyAISDKSpan(
  name: string,
  attributes: Record<string, unknown>,
): AISDKSpanClassification {
  const originalName = getStringAttribute(attributes, RAWTREE_AI_ORIGINAL_NAME_ATTRIBUTE) ?? name;
  const operationId = getStringAttribute(attributes, AI_OPERATION_ID_ATTRIBUTE)
    ?? (originalName.startsWith("ai.") ? originalName : undefined);
  const operation = getStringAttribute(attributes, RAWTREE_AI_OPERATION_ATTRIBUTE)
    ?? getStringAttribute(attributes, GEN_AI_OPERATION_NAME_ATTRIBUTE)
    ?? operationFromName(operationId)
    ?? operationFromName(originalName);
  const pipelineName = getStringAttribute(attributes, RAWTREE_AI_PIPELINE_NAME_ATTRIBUTE)
    ?? (originalName.startsWith("ai.") ? originalName.slice(3) : undefined);
  const isAISDKSpan = getStringAttribute(attributes, RAWTREE_ORIGIN_ATTRIBUTE) === RAWTREE_AI_ORIGIN
    || getStringAttribute(attributes, AI_OPERATION_ID_ATTRIBUTE)?.startsWith("ai.") === true
    || originalName.startsWith("ai.")
    || name.startsWith("ai.")
    || typeof attributes[AI_TOOL_CALL_NAME_ATTRIBUTE] === "string";

  return {
    isAISDKSpan,
    originalName,
    operationId,
    operation,
    pipelineName,
  };
}

function annotateAISDKSpan(span: Span, classification: AISDKSpanClassification): void {
  span.setAttribute(RAWTREE_ORIGIN_ATTRIBUTE, RAWTREE_AI_ORIGIN);
  span.setAttribute(RAWTREE_AI_ORIGINAL_NAME_ATTRIBUTE, classification.originalName);

  if (classification.pipelineName) {
    span.setAttribute(RAWTREE_AI_PIPELINE_NAME_ATTRIBUTE, classification.pipelineName);
  }

  if (classification.operation) {
    span.setAttribute(RAWTREE_AI_OPERATION_ATTRIBUTE, classification.operation);
    span.setAttribute(GEN_AI_OPERATION_NAME_ATTRIBUTE, classification.operation);
  }

  const model = getStringAttribute(span.attributes, AI_RESPONSE_MODEL_ATTRIBUTE)
    ?? getStringAttribute(span.attributes, AI_MODEL_ID_ATTRIBUTE);
  const functionId = getStringAttribute(span.attributes, AI_TELEMETRY_FUNCTION_ID_ATTRIBUTE);

  if (model) {
    span.setAttribute(GEN_AI_REQUEST_MODEL_ATTRIBUTE, model);
    span.setAttribute(GEN_AI_RESPONSE_MODEL_ATTRIBUTE, model);
  }

  const toolName = getStringAttribute(span.attributes, AI_TOOL_CALL_NAME_ATTRIBUTE);
  const toolCallId = getStringAttribute(span.attributes, AI_TOOL_CALL_ID_ATTRIBUTE);

  if (toolName) {
    span.setAttribute(GEN_AI_TOOL_NAME_ATTRIBUTE, toolName);
    span.setAttribute(GEN_AI_TOOL_TYPE_ATTRIBUTE, "function");
  }

  if (toolCallId) {
    span.setAttribute(GEN_AI_TOOL_CALL_ID_ATTRIBUTE, toolCallId);
  }

  const nextName = getNormalizedSpanName(classification, model, toolName, functionId);

  if (nextName) {
    span.updateName(nextName);
  }
}

function getNormalizedSpanName(
  classification: AISDKSpanClassification,
  model: string | undefined,
  toolName: string | undefined,
  functionId: string | undefined,
): string | undefined {
  if (classification.operation === "invoke_agent") {
    return functionId ? `invoke_agent ${functionId}` : "invoke_agent";
  }

  if (classification.operation === "execute_tool") {
    return toolName ? `execute_tool ${toolName}` : "execute_tool";
  }

  if (classification.operation && model) {
    return `${classification.operation} ${model}`;
  }

  return classification.pipelineName;
}

function operationFromName(name: string | undefined): string | undefined {
  if (!name) {
    return undefined;
  }

  return SPAN_TO_OPERATION_NAME.get(name);
}

function getEventName(
  classification: AISDKSpanClassification,
  options: RawTreeAISDKIntegrationOptions,
): string {
  if (options.eventName) {
    return options.eventName;
  }

  const prefix = options.eventPrefix ?? DEFAULT_EVENT_PREFIX;
  return classification.operation ? `${prefix}.${classification.operation}` : `${prefix}.otel.span`;
}

function isTelemetryBridgeActive(): boolean {
  return telemetryBridgeRegistrationCount > 0;
}

function isV7OperationStartEvent(record: Record<string, unknown>): boolean {
  return typeof record.callId === "string"
    && typeof record.operationId === "string"
    && typeof record.provider === "string"
    && typeof record.modelId === "string";
}

function createOperationStartAttributes(record: Record<string, unknown>): Attributes {
  const operationId = getStringAttribute(record, "operationId") ?? "ai.generateText";
  const attributes: Attributes = {
    "operation.name": operationName(operationId, getStringAttribute(record, "functionId")),
    "ai.operationId": operationId,
  };

  setAttribute(attributes, "resource.name", record.functionId);
  setAttribute(attributes, AI_TELEMETRY_FUNCTION_ID_ATTRIBUTE, record.functionId);
  setAttribute(attributes, AI_MODEL_PROVIDER_ATTRIBUTE, record.provider);
  setAttribute(attributes, AI_MODEL_ID_ATTRIBUTE, record.modelId);
  setAttribute(attributes, "ai.prompt", pickRecord(record, ["instructions", "system", "prompt", "messages"]));
  setAttribute(attributes, "ai.prompt.tools", record.tools);
  setAttribute(attributes, "ai.prompt.toolChoice", record.toolChoice);
  setAttribute(attributes, "ai.settings.maxOutputTokens", record.maxOutputTokens);
  setAttribute(attributes, "ai.settings.temperature", record.temperature);
  setAttribute(attributes, "ai.settings.topP", record.topP);
  setAttribute(attributes, "ai.settings.topK", record.topK);
  setAttribute(attributes, "ai.settings.presencePenalty", record.presencePenalty);
  setAttribute(attributes, "ai.settings.frequencyPenalty", record.frequencyPenalty);
  setAttribute(attributes, "ai.settings.stopSequences", record.stopSequences);
  setAttribute(attributes, "ai.settings.seed", record.seed);
  setAttribute(attributes, "ai.settings.maxRetries", record.maxRetries);

  return attributes;
}

function createOperationEndAttributes(record: Record<string, unknown>): Attributes {
  const attributes: Attributes = {};
  const model = asRecord(record.model);

  setAttribute(attributes, AI_MODEL_PROVIDER_ATTRIBUTE, model.provider);
  setAttribute(attributes, AI_MODEL_ID_ATTRIBUTE, model.modelId);
  setAttribute(attributes, "ai.response.finishReason", record.finishReason);
  setAttribute(attributes, "ai.response.text", record.text);
  setAttribute(attributes, "ai.response.reasoning", record.reasoningText ?? record.reasoning);
  setAttribute(attributes, "ai.response.toolCalls", record.toolCalls);
  setAttribute(attributes, "ai.response.providerMetadata", record.providerMetadata);
  setUsageAttributes(attributes, record.usage ?? record.totalUsage);

  return attributes;
}

function createLanguageModelCallStartAttributes(
  record: Record<string, unknown>,
  operationId: string,
): Attributes {
  const attributes: Attributes = {
    "operation.name": operationName(operationId, getStringAttribute(record, "functionId")),
    "ai.operationId": operationId,
  };

  setAttribute(attributes, "resource.name", record.functionId);
  setAttribute(attributes, AI_TELEMETRY_FUNCTION_ID_ATTRIBUTE, record.functionId);
  setAttribute(attributes, "ai.call.id", record.callId);
  setAttribute(attributes, AI_MODEL_PROVIDER_ATTRIBUTE, record.provider);
  setAttribute(attributes, AI_MODEL_ID_ATTRIBUTE, record.modelId);
  setAttribute(attributes, "ai.prompt.messages", record.messages);
  setAttribute(attributes, "ai.prompt.tools", record.tools);
  setAttribute(attributes, "ai.prompt.toolChoice", record.toolChoice);
  setAttribute(attributes, "ai.settings.maxOutputTokens", record.maxOutputTokens);
  setAttribute(attributes, "ai.settings.temperature", record.temperature);
  setAttribute(attributes, "ai.settings.topP", record.topP);
  setAttribute(attributes, "ai.settings.topK", record.topK);
  setAttribute(attributes, "ai.settings.presencePenalty", record.presencePenalty);
  setAttribute(attributes, "ai.settings.frequencyPenalty", record.frequencyPenalty);
  setAttribute(attributes, "ai.settings.stopSequences", record.stopSequences);
  setAttribute(attributes, "ai.settings.seed", record.seed);

  return attributes;
}

function createLanguageModelCallEndAttributes(record: Record<string, unknown>): Attributes {
  const attributes: Attributes = {};

  setAttribute(attributes, AI_MODEL_PROVIDER_ATTRIBUTE, record.provider);
  setAttribute(attributes, AI_MODEL_ID_ATTRIBUTE, record.modelId);
  setAttribute(attributes, AI_RESPONSE_MODEL_ATTRIBUTE, record.modelId);
  setAttribute(attributes, "ai.response.finishReason", record.finishReason);
  setAttribute(attributes, "ai.response.id", record.responseId);
  setAttribute(attributes, "ai.response.content", record.content);
  setAttribute(attributes, "ai.response.performance", record.performance);
  setUsageAttributes(attributes, record.usage);

  return attributes;
}

function createToolExecutionStartAttributes(event: unknown): Attributes {
  const record = asRecord(event);
  const toolCall = asRecord(record.toolCall);
  const attributes: Attributes = {
    "operation.name": operationName("ai.toolCall", getStringAttribute(record, "functionId")),
    "ai.operationId": "ai.toolCall",
  };

  setAttribute(attributes, "resource.name", record.functionId);
  setAttribute(attributes, AI_TELEMETRY_FUNCTION_ID_ATTRIBUTE, record.functionId);
  setAttribute(attributes, "ai.call.id", record.callId);
  setAttribute(attributes, AI_TOOL_CALL_NAME_ATTRIBUTE, toolCall.toolName);
  setAttribute(attributes, AI_TOOL_CALL_ID_ATTRIBUTE, toolCall.toolCallId);
  setAttribute(attributes, "ai.toolCall.args", toolCall.input);
  setAttribute(attributes, "ai.toolCall.type", toolCall.type);

  return attributes;
}

function createToolExecutionEndAttributes(record: Record<string, unknown>): Attributes {
  const attributes: Attributes = {};
  const toolOutput = asRecord(record.toolOutput);

  setAttribute(attributes, "ai.toolCall.result", toolOutput.output ?? toolOutput.result);
  setAttribute(attributes, "ai.toolCall.outputType", toolOutput.type);
  setAttribute(attributes, "ai.toolCall.durationMs", record.toolExecutionMs);

  return attributes;
}

function getLanguageModelCallOperationId(operationId: string | undefined): string {
  if (operationId === "ai.streamText" || operationId === "ai.streamObject") {
    return `${operationId}.doStream`;
  }

  if (operationId === "ai.generateObject") {
    return "ai.generateObject.doGenerate";
  }

  return "ai.generateText.doGenerate";
}

function operationName(operationId: string, functionId: string | undefined): string {
  return functionId ? `${operationId} ${functionId}` : operationId;
}

function setUsageAttributes(attributes: Attributes, usage: unknown): void {
  const record = asRecord(usage);

  setAttribute(attributes, "ai.usage.inputTokens", record.inputTokens);
  setAttribute(attributes, "ai.usage.outputTokens", record.outputTokens);
  setAttribute(attributes, "ai.usage.totalTokens", record.totalTokens);
  setAttribute(attributes, "ai.usage.reasoningTokens", record.reasoningTokens);
  setAttribute(attributes, "ai.usage.cachedInputTokens", record.cachedInputTokens);

  const inputTokenDetails = asRecord(record.inputTokenDetails);
  const outputTokenDetails = asRecord(record.outputTokenDetails);

  setAttribute(attributes, "ai.usage.inputTokenDetails.noCacheTokens", inputTokenDetails.noCacheTokens);
  setAttribute(attributes, "ai.usage.inputTokenDetails.cacheReadTokens", inputTokenDetails.cacheReadTokens);
  setAttribute(attributes, "ai.usage.inputTokenDetails.cacheWriteTokens", inputTokenDetails.cacheWriteTokens);
  setAttribute(attributes, "ai.usage.outputTokenDetails.textTokens", outputTokenDetails.textTokens);
  setAttribute(attributes, "ai.usage.outputTokenDetails.reasoningTokens", outputTokenDetails.reasoningTokens);
}

function setAttribute(attributes: Attributes, key: string, value: unknown): void {
  const attribute = toAttributeValue(value);

  if (attribute !== undefined) {
    attributes[key] = attribute;
  }
}

function toAttributeValue(value: unknown): Attributes[string] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  return safeStringify(value);
}

function pickRecord(record: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> | undefined {
  const result: Record<string, unknown> = {};

  for (const key of keys) {
    if (record[key] !== undefined) {
      result[key] = record[key];
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(normalizeValue(value));
  } catch {
    return String(value);
  }
}

function isToolErrorOutput(output: unknown): boolean {
  const record = asRecord(output);
  return record.type === "error" || record.type === "tool-error";
}

function getToolErrorMessage(output: unknown): string | undefined {
  const record = asRecord(output);
  const error = asRecord(record.error);
  return typeof error.message === "string" ? error.message : undefined;
}

function recordErrorOnSpan(span: ApiSpan, error: unknown): void {
  if (error instanceof Error) {
    span.recordException(error);
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: error.message,
    });
    return;
  }

  span.setStatus({ code: SpanStatusCode.ERROR });
}

function sanitizeAISDKAttributes(
  attributes: Record<string, unknown>,
  options: RawTreeAISDKIntegrationOptions,
): Record<string, unknown> | undefined {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(attributes)) {
    if (options.captureInputs === false && isInputAttribute(key)) {
      continue;
    }

    if (options.captureOutputs === false && isOutputAttribute(key)) {
      continue;
    }

    if (options.captureProviderMetadata === false && isProviderMetadataAttribute(key)) {
      continue;
    }

    result[key] = truncateCapturedValue(
      normalizeValue(value),
      options.maxCapturedContentLength ?? DEFAULT_MAX_CAPTURED_CONTENT_LENGTH,
    );
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function isInputAttribute(key: string): boolean {
  return key === "ai.prompt"
    || key === "ai.prompt.messages"
    || key === "ai.prompt.tools"
    || key === "ai.prompt.toolChoice"
    || key === "ai.schema"
    || key === "ai.values"
    || key === "ai.toolCall.args"
    || key === "gen_ai.input.messages"
    || key === "gen_ai.prompt";
}

function isOutputAttribute(key: string): boolean {
  return key === "ai.response.text"
    || key === "ai.response.reasoning"
    || key === "ai.response.object"
    || key === "ai.response.toolCalls"
    || key === "ai.toolCall.result"
    || key === "gen_ai.output.messages"
    || key === "gen_ai.tool.output";
}

function isProviderMetadataAttribute(key: string): boolean {
  return key === "ai.response.providerMetadata"
    || key === "providerMetadata"
    || key.endsWith(".providerMetadata");
}

function truncateCapturedValue(value: unknown, maxLength: number): unknown {
  if (typeof value === "string") {
    return value.length > maxLength ? `${value.slice(0, maxLength)}...[truncated]` : value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => truncateCapturedValue(item, maxLength));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, truncateCapturedValue(item, maxLength)]),
    );
  }

  return value;
}

function getStringAttribute(
  attributes: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = attributes[key];
  return typeof value === "string" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}
