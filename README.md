# RawTree TypeScript SDK

> Experimental: this SDK is early and its public API may change before a stable release.

TypeScript packages for building apps with RawTree.

## Packages

- `@rawtree/sdk`: RawTree API client for query, insert, and table metadata.
- `@rawtree/otel`: Sentry-style monitoring client, shared OpenTelemetry setup,
  and optional AI SDK integration.

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

Install the tools you want to monitor as peers. For the AI SDK harness example:

```sh
npm install ai @ai-sdk/otel @ai-sdk/harness @ai-sdk/harness-claude-code @ai-sdk/sandbox-vercel
```

```ts
import { HarnessAgent } from "@ai-sdk/harness/agent";
import { claudeCode } from "@ai-sdk/harness-claude-code";
import { createVercelSandbox } from "@ai-sdk/sandbox-vercel";
import { initRawTree, aiSdkIntegration } from "@rawtree/otel";

const rawtree = initRawTree({
  apiKey: process.env.RAWTREE_API_KEY!,
  table: "events",
  service: "ai-sdk",
  environment: "production",
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
  await rawtree.flush();
  await rawtree.close();
}
```

AI SDK spans are stored as `ai.sdk.otel.span` with the original span name,
attributes, resource, scope, and timing preserved in the payload. Spans created
under the same active context share `trace_id`, `span_id`, and `parent_span_id`.

Manual events are supported too:

```ts
rawtree.capture("checkout.started", {
  userId: "u_123",
});

await rawtree.span("billing.charge", async () => {
  await chargeCustomer();
});
```

See `examples/ai-sdk` for the AI SDK canary `HarnessAgent` flow with Claude
Code running in Vercel Sandbox. It expects `RAWTREE_API_KEY`, plus whatever
credentials your Claude Code and Vercel Sandbox setup require.

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
