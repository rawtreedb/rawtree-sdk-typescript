# RawTree TypeScript SDK

> Experimental: this SDK is early and its public API may change before a stable release.

TypeScript packages for building apps with RawTree.

## Packages

- `@rawtree/sdk`: RawTree API client for query, insert, and table metadata.
- `@rawtree/otel`: Sentry-style monitoring client, shared OpenTelemetry setup,
  and optional integrations such as AI SDK and Daytona.

## Install

```sh
npm install @rawtree/sdk
```

## Usage

```ts
import { RawTree } from "@rawtree/sdk";

const rawtree = new RawTree({
  apiKey: process.env.RAWTREE_API_KEY!,
});

await rawtree.insert("events", [
  { event: "signup", user_id: "u_123" },
]);

const result = await rawtree.query<{ event: string; count: number }>(
  "SELECT event, count() AS count FROM events GROUP BY event"
);

const tables = await rawtree.tables.list();
const schema = await rawtree.tables.describe("events");
```

## Monitoring

RawTree can also be used as a Sentry-style monitoring sink. Initialize a monitoring
client, add integrations, and flush events into a RawTree table. The AI SDK
integration captures AI SDK OpenTelemetry spans when the SDK emits them. For
AI SDK 7, install `@ai-sdk/otel`; RawTree will register AI SDK's official
OpenTelemetry integration for you when `aiSdkIntegration()` is enabled.

```sh
npm install @rawtree/otel
```

Install the tools you want to monitor as peers. For AI SDK v7 telemetry:

```sh
npm install ai @ai-sdk/otel
```

```ts
import { initRawTree, aiSdkIntegration, daytonaIntegration } from "@rawtree/otel";
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";

const rawtree = initRawTree({
  apiKey: process.env.RAWTREE_API_KEY!,
  table: "events",
  service: "api",
  environment: "production",
  integrations: [
    aiSdkIntegration(),
    daytonaIntegration(),
  ],
});

await generateText({
  model: openai(process.env.OPENAI_MODEL ?? "gpt-4o"),
  prompt: "Explain RawTree in one sentence.",
  experimental_telemetry: {
    isEnabled: true,
    recordInputs: true,
    recordOutputs: true,
  },
});

await rawtree.flush();
```

AI SDK spans are stored as `ai.sdk.otel.span` with the original span name,
attributes, resource, scope, and timing preserved in the payload. Daytona spans
are stored as `daytona.otel.span`. Both integrations use the same in-process
OpenTelemetry provider, so spans created under the same active context share
`trace_id`, `span_id`, and `parent_span_id`.

Manual events are supported too:

```ts
rawtree.capture("checkout.started", {
  userId: "u_123",
});

await rawtree.span("billing.charge", async () => {
  await chargeCustomer();
});
```

See `examples/ai-sdk-openai` for a runnable OpenAI + AI SDK example with multiple
AI SDK tools. It expects `RAWTREE_API_KEY` and `OPENAI_API_KEY`.

See `examples/harness-agent-vercel` for the AI SDK canary `HarnessAgent` flow
with Claude Code running in Vercel Sandbox. It expects `RAWTREE_API_KEY`, plus
whatever credentials your Claude Code and Vercel Sandbox setup require.

See `examples/harness-agent-daytona` for the same `HarnessAgent` flow running
in a Daytona sandbox. It sends both AI SDK telemetry and Daytona OpenTelemetry
spans to RawTree. It expects `RAWTREE_API_KEY`, `DAYTONA_API_KEY`, and Claude
Code model credentials. RawTree captures Daytona spans in-process through the
shared provider; you do not need to enable Daytona's OTLP exporter.

## API

```ts
new RawTree({
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
});
```

The SDK sends the API key as `Authorization: Bearer <apiKey>`.

### query

```ts
rawtree.query<Row = unknown>(
  sql: string | { sql: string },
  options?: RequestOptions,
): Promise<QueryResponse<Row>>;
```

### insert

```ts
rawtree.insert<Row extends JsonObject = JsonObject>(
  table: string,
  rows: Row | Row[],
  options?: RequestOptions,
): Promise<InsertResponse>;
```

### tables

```ts
rawtree.tables.list(options?: RequestOptions): Promise<TablesResponse>;
rawtree.tables.describe(table: string, options?: RequestOptions): Promise<DescribeTableResponse>;
```
