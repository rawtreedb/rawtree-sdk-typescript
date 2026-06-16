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
    experimental_telemetry: {
      isEnabled: true,
      recordInputs: true,
      recordOutputs: true,
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
    recordInputs: true,
    recordOutputs: true,
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

Daytona has its own OpenTelemetry exporter. RawTree does not import Daytona or
wrap the Daytona client. Instead, `configureDaytonaOtel()` configures the OTLP
environment variables that Daytona reads when you enable its telemetry.

```ts
import { Daytona } from "@daytona/sdk";
import { configureDaytonaOtel } from "@rawtree/otel/daytona";

const daytonaOtel = configureDaytonaOtel({
  apiKey: process.env.RAWTREE_API_KEY!,
});

const daytona = new Daytona({
  apiKey: process.env.DAYTONA_API_KEY!,
  otelEnabled: true,
});

try {
  // Use Daytona here.
} finally {
  await daytona[Symbol.asyncDispose]();
  daytonaOtel.shutdown();
}
```

Call `configureDaytonaOtel()` before constructing Daytona or a Daytona-backed
sandbox. When Daytona telemetry is enabled, the Daytona SDK reads:

```text
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://api.rawtree.com/otlp/v1/traces
OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=https://api.rawtree.com/otlp/v1/metrics
OTEL_EXPORTER_OTLP_HEADERS=authorization=Bearer%20...
```

By default, RawTree writes Daytona traces to the `traces` table and Daytona
metrics to the `metrics` table. Use `tracesTable` or `metricsTable` when you
want separate tables:

```ts
configureDaytonaOtel({
  tracesTable: "daytona_traces",
  metricsTable: "daytona_metrics",
});
```

Do not call `registerOTel()` solely for Daytona. Daytona starts its own
OpenTelemetry SDK when `otelEnabled: true` is set, so the Daytona path should
use `configureDaytonaOtel()` and RawTree's native OTLP endpoints.

See `examples/daytona` in this repository for a runnable Daytona example.

## What RawTree Receives

`registerOTel()` sends OpenTelemetry trace spans to the `traces` table by
default using RawTree's `otlp-traces` transform. The exporter posts OTLP JSON to:

```text
/v1/tables/traces?transform=otlp-traces
```

RawTree stores one row per span. Each row starts with the OTLP span fields such
as `traceId`, `spanId`, `parentSpanId`, `name`, `startTimeUnixNano`,
`endTimeUnixNano`, `attributes`, `events`, `links`, and `status`. RawTree also
merges resource attributes such as `service.name`, and adds `scope.name` when
the source scope has a name.

`serviceName` is stored as the standard OpenTelemetry resource attribute
`service.name`.

Daytona's own exporter sends OTLP HTTP/protobuf directly to RawTree's native
OpenTelemetry endpoints:

```text
/otlp/v1/traces
/otlp/v1/metrics
```

The package currently exports traces. Future logs and metrics support should use
the default RawTree tables `logs` and `metrics`.

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

Most Daytona apps should use `configureDaytonaOtel()` because Daytona owns its
own OpenTelemetry SDK when `otelEnabled: true` is set.

```ts
daytonaIntegration({
  apiKey?: string;
  baseUrl?: string;
  endpoint?: string;
  tracesTable?: string;
  metricsTable?: string;
  headers?: Record<string, string>;
});
```

### configureDaytonaOtel

Use this helper when you want to configure Daytona's own exporter without
calling `registerOTel()`.

```ts
const daytonaOtel = configureDaytonaOtel({
  apiKey: string;
  baseUrl?: string;
  endpoint?: string;
  tracesTable?: string;
  metricsTable?: string;
  headers?: Record<string, string>;
});

daytonaOtel.shutdown();
```

### RawTreeTraceExporter

Use this when you want to wire RawTree into an existing OpenTelemetry setup
instead of calling `registerOTel()`.

```ts
new RawTreeTraceExporter({
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  table?: string;
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
import { daytonaIntegration, configureDaytonaOtel } from "@rawtree/otel/daytona";
```

```ts
import { RawTreeTraceExporter } from "@rawtree/otel/exporter";
```

```ts
import { registerOTel } from "@rawtree/otel/register";
```
