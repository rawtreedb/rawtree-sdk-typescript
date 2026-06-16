# @rawtree/otel

OpenTelemetry monitoring integrations for RawTree.

Use this package to quickly register OpenTelemetry tracing and metrics and send
them to RawTree:

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

RawTree is installed as the OpenTelemetry trace and metric exporter.
Integrations enable tool-specific telemetry, and RawTree ingests the resulting
unstructured OTLP payloads so you can query them later.

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

RawTree does not import Daytona or wrap the Daytona client. Register RawTree
once when your process starts and add `daytonaIntegration()` with your other
integrations. Daytona SDK spans are exported by the RawTree OpenTelemetry
provider. Daytona SDK duration histograms are exported by the RawTree
OpenTelemetry meter provider.

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

`registerOTel()` sends OpenTelemetry trace spans to the `traces` table by
default using RawTree's `otlp-traces` transform. It sends OpenTelemetry metrics
to the `metrics` table by default using RawTree's `otlp-metrics` transform.

The trace exporter posts OTLP JSON to:

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

The metric exporter posts OTLP JSON to:

```text
/v1/tables/metrics?transform=otlp-metrics
```

RawTree stores one row per metric data point. Daytona currently emits duration
histograms for decorated SDK methods, with attributes such as `component`,
`method`, and `status`.

Future logs support should use the default RawTree table `logs`.

## Process Setup

Call `registerOTel()` once during process startup, before the libraries you want
to monitor start doing work.

For scripts and tests, call `await rawtree.shutdown()` before exit so buffered
spans and metrics are flushed. For servers and workers, call it from your
shutdown path:

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

`registerOTel()` registers a tracer provider and meter provider for you. If your
app already owns OpenTelemetry provider setup, use `RawTreeTraceExporter` and
`RawTreeMetricExporter` with your existing processor and reader setup instead.

```ts
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { RawTreeMetricExporter, RawTreeTraceExporter } from "@rawtree/otel/exporter";

const traceExporter = new RawTreeTraceExporter({
  apiKey: process.env.RAWTREE_API_KEY!,
});

const metricExporter = new RawTreeMetricExporter({
  apiKey: process.env.RAWTREE_API_KEY!,
});

const spanProcessor = new BatchSpanProcessor(traceExporter);
const metricReader = new PeriodicExportingMetricReader({
  exporter: metricExporter,
});

// Add spanProcessor and metricReader to the providers your app already creates.
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
  metrics?: boolean;
  metricExporter?: RawTreeMetricExporter;
  metricReader?: "periodic" | MetricReader;
  metricReaderOptions?: Omit<PeriodicExportingMetricReaderOptions, "exporter">;
  forceRegisterProvider?: boolean;
  unregisterOnShutdown?: boolean;
});
```

Returns:

```ts
{
  exporter: RawTreeTraceExporter;
  metricExporter?: RawTreeMetricExporter;
  providerRegistered: boolean;
  meterProviderRegistered: boolean;
  shutdown: () => Promise<void>;
}
```

Metrics are enabled by default when `registerOTel()` owns the RawTree API
connection. Pass `metrics: false` if your app already has a meter provider and
you only want RawTree to register traces.

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
  baseUrl?: string;
  fetch?: typeof fetch;
  table?: string;
});
```

### RawTreeMetricExporter

Use this when you want to wire RawTree metrics into an existing OpenTelemetry
setup instead of calling `registerOTel()`.

```ts
new RawTreeMetricExporter({
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
import { daytonaIntegration } from "@rawtree/otel/daytona";
```

```ts
import { RawTreeMetricExporter, RawTreeTraceExporter } from "@rawtree/otel/exporter";
```

```ts
import { registerOTel } from "@rawtree/otel/register";
```

```ts
import { registerRawTreeMeterProvider } from "@rawtree/otel/metrics";
```
