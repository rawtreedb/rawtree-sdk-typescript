# @rawtree/otel

OpenTelemetry monitoring integrations for RawTree.

Use this package to quickly register OpenTelemetry tracing and send spans to
RawTree:

```ts
import { registerOTel, aiSdkIntegration } from "@rawtree/otel";

const rawtree = registerOTel({
  apiKey: process.env.RAWTREE_API_KEY!,
  serviceName: "api",
  integrations: [
    aiSdkIntegration(),
  ],
});
```

RawTree is installed as the OpenTelemetry span exporter. Integrations enable
tool-specific telemetry, and RawTree ingests the resulting unstructured spans so
you can query them later.

## Install

```sh
npm install @rawtree/otel
```

For AI SDK telemetry, install the AI SDK packages you use plus the official AI
SDK OpenTelemetry bridge:

```sh
npm install ai @ai-sdk/otel
```

Provider packages are installed separately. For example, OpenAI usage also needs
the AI SDK OpenAI provider:

```sh
npm install @ai-sdk/openai
```

For Daytona telemetry, install Daytona separately:

```sh
npm install @daytona/sdk
```

## AI SDK

RawTree does not wrap your model or agent. Enable RawTree once when your process
starts, then use AI SDK telemetry on the AI SDK call or agent.

> **Privacy: prompts and outputs are recorded by default.** Spans stored in
> RawTree include full prompt and message text in `gen_ai.input.messages` (plus
> system instructions) and full model responses in `gen_ai.output.messages`. To
> keep span timing, model, and token usage without that content, set the AI SDK
> telemetry options on each call or agent:
>
> ```ts
> telemetry: {
>   recordInputs: false,
>   recordOutputs: false,
> },
> ```

```ts
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";
import { registerOTel, aiSdkIntegration } from "@rawtree/otel";

const rawtree = registerOTel({
  apiKey: process.env.RAWTREE_API_KEY!,
  serviceName: "checkout-agent",
  environment: process.env.NODE_ENV ?? "development",
  integrations: [
    aiSdkIntegration(),
  ],
});

try {
  const result = await generateText({
    model: openai("gpt-4o"),
    prompt: "Summarize the latest checkout incident.",
    telemetry: {
      functionId: "checkout-incident-summary",
    },
  });

  console.log(result.text);
} finally {
  await rawtree.shutdown();
}
```

For AI SDK harness agents, pass telemetry to the agent:

```ts
import { HarnessAgent } from "@ai-sdk/harness/agent";
import { claudeCode } from "@ai-sdk/harness-claude-code";
import { createVercelSandbox } from "@ai-sdk/sandbox-vercel";
import { registerOTel, aiSdkIntegration } from "@rawtree/otel";

const rawtree = registerOTel({
  apiKey: process.env.RAWTREE_API_KEY!,
  serviceName: "ai-sdk",
  integrations: [
    aiSdkIntegration(),
  ],
});

const agent = new HarnessAgent({
  id: "support-agent",
  harness: claudeCode,
  sandbox: createVercelSandbox({ runtime: "node24" }),
  telemetry: {
    functionId: "support-agent",
  },
});

const session = await agent.createSession();

try {
  const result = await agent.stream({
    session,
    prompt: "Investigate checkout latency and suggest a mitigation.",
  });

  for await (const _part of result.fullStream) {
    // Consume the stream so the agent run completes.
  }
} finally {
  await session.destroy();
  await rawtree.shutdown();
}
```

See `examples/ai-sdk` in this repository for a runnable harness agent example.

## Daytona

RawTree does not import Daytona or wrap the Daytona client. Register RawTree
once when your process starts and add `daytonaIntegration()` with your other
integrations. Daytona SDK spans are exported by the RawTree OpenTelemetry
provider.

```ts
import { Daytona } from "@daytona/sdk";
import { registerOTel, aiSdkIntegration, daytonaIntegration } from "@rawtree/otel";

const rawtree = registerOTel({
  apiKey: process.env.RAWTREE_API_KEY!,
  serviceName: "agent-api",
  integrations: [
    aiSdkIntegration(),
    daytonaIntegration(),
  ],
});

const daytona = new Daytona({
  apiKey: process.env.DAYTONA_API_KEY!,
});

try {
  // Use Daytona here.
} finally {
  await daytona[Symbol.asyncDispose]();
  await rawtree.shutdown();
}
```

Do not pass `otelEnabled: true` when using `daytonaIntegration()`.
`registerOTel()` owns the process OpenTelemetry provider, and the integration
keeps Daytona from starting a second provider through its environment flags.

See `examples/daytona` in this repository for a runnable Daytona example.

## What RawTree Receives

`registerOTel()` sends OpenTelemetry trace spans to RawTree's insert API using
the `otlp-traces` transform. The exporter posts OTLP JSON to:

```text
/v1/tables/<table>?transform=otlp-traces
```

The table defaults to `traces`. Pass `table` to write spans to a different
table, and `database` to pick a database other than your default:

```ts
const rawtree = registerOTel({
  apiKey: process.env.RAWTREE_API_KEY!,
  database: "observability",
  table: "ai_traces",
  serviceName: "checkout-agent",
  integrations: [
    aiSdkIntegration(),
  ],
});
```

`RawTreeTraceExporter` accepts the same `table` option. The exporter only
exports traces, so the table receives one row per span.

RawTree stores one row per span. Each row starts with the OTLP span fields such
as `traceId`, `spanId`, `parentSpanId`, `name`, `startTimeUnixNano`,
`endTimeUnixNano`, `attributes`, `events`, `links`, and `status`. RawTree also
merges resource attributes such as `service.name`, and adds `scope.name` when
the source scope has a name.

`serviceName` is stored as the standard OpenTelemetry resource attribute
`service.name`.

The package currently exports traces. Future logs and metrics support should
use the default RawTree tables `logs` and `metrics`.

## Process Setup

Call `registerOTel()` once during process startup, before the libraries you want
to monitor start doing work.

For scripts and tests, call `await rawtree.shutdown()` before exit so buffered
spans are flushed. For servers and workers, call it from your shutdown path:

```ts
const rawtree = registerOTel({
  apiKey: process.env.RAWTREE_API_KEY!,
  serviceName: "api",
  integrations: [
    aiSdkIntegration(),
  ],
});

process.on("SIGTERM", () => {
  void rawtree.shutdown().finally(() => process.exit(0));
});
```

## Export Errors

Failed exports do not throw into your app. By default, the first failed export
is logged with `console.error`. Repeats of the same message are not logged
again. A failure with a different message is logged once. `shutdown()` flushes
pending spans and does not reject when an export fails.

Pass `onExportError` to handle failures yourself. It replaces the default
`console.error` logging and is called for every failed export:

```ts
const rawtree = registerOTel({
  apiKey: process.env.RAWTREE_API_KEY!,
  serviceName: "api",
  onExportError: (error) => {
    logger.warn({ err: error }, "RawTree trace export failed");
  },
});
```

`RawTreeTraceExporter` accepts the same `onExportError` option.

## Existing OpenTelemetry Setup

`registerOTel()` registers a tracer provider for you. If your app already owns
OpenTelemetry provider setup, use `RawTreeTraceExporter` with your existing span
processor setup instead.

```ts
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { RawTreeTraceExporter } from "@rawtree/otel/exporter";

const exporter = new RawTreeTraceExporter({
  apiKey: process.env.RAWTREE_API_KEY!,
});

const spanProcessor = new BatchSpanProcessor(exporter);

// Add spanProcessor to the tracer provider your app already creates.
```

If you already register the AI SDK OpenTelemetry bridge yourself, disable
RawTree's bridge registration:

```ts
aiSdkIntegration({
  registerOpenTelemetry: false,
});
```

## API

### registerOTel

```ts
registerOTel({
  apiKey: string;
  database?: string;
  baseUrl?: string;
  table?: string; // default: "traces"
  onExportError?: (error: Error) => void;
  serviceName?: string;
  environment?: string;
  release?: string;
  attributes?: Attributes;
  integrations?: RawTreeIntegration[];
  spanProcessor?: "batch" | "simple" | SpanProcessor;
  batchSpanProcessorOptions?: BufferConfig;
  forceRegisterProvider?: boolean;
  unregisterOnShutdown?: boolean;
});
```

Returns:

```ts
{
  exporter: RawTreeTraceExporter;
  providerRegistered: boolean;
  shutdown: () => Promise<void>;
}
```

### aiSdkIntegration

```ts
aiSdkIntegration({
  registerOpenTelemetry?: boolean;
  captureResource?: boolean;
  captureScope?: boolean;
  captureEvents?: boolean;
  captureLinks?: boolean;
});
```

### daytonaIntegration

```ts
daytonaIntegration();
```

### RawTreeTraceExporter

Use this when you want to wire RawTree into an existing OpenTelemetry setup
instead of calling `registerOTel()`.

```ts
new RawTreeTraceExporter({
  apiKey: string;
  database?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  table?: string; // default: "traces"
  onExportError?: (error: Error) => void;
});
```

## Imports

```ts
import { registerOTel, aiSdkIntegration } from "@rawtree/otel";
```

```ts
import { aiSdkIntegration } from "@rawtree/otel/ai-sdk";
```

```ts
import { daytonaIntegration } from "@rawtree/otel/daytona";
```

```ts
import { RawTreeTraceExporter } from "@rawtree/otel/exporter";
```

```ts
import { registerOTel } from "@rawtree/otel/register";
```
