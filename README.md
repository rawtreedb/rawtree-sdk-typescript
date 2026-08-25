# RawTree TypeScript SDK

> Experimental: this SDK is early and its public API may change before a stable release.

TypeScript packages for building apps with RawTree.

## Packages

- `@rawtree/sdk`: RawTree API client for query, insert, and table metadata.
- `@rawtree/otel`: OpenTelemetry setup, RawTree trace export, and optional AI
  SDK integration.

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

await rawtree.insert({
  table: "events",
  values: [
    { event: "signup", user_id: "u_123" },
  ],
});

const result = await rawtree.query<{ event: string; count: number }>({
  sql: "SELECT event, count() AS count FROM events GROUP BY event",
});

const tables = await rawtree.tables.list();
const schema = await rawtree.tables.describe({ table: "events" });
```

## Monitoring

RawTree can also be used as an OpenTelemetry sink. Register RawTree as the OTel
exporter, add integrations, and send trace spans to RawTree. For AI SDK 7,
install `@ai-sdk/otel`; RawTree will register AI SDK's official OpenTelemetry
integration for you when `aiSdkIntegration()` is enabled.

```sh
npm install @rawtree/otel
```

The package-level README at `packages/otel/README.md` has the full setup guide,
including install commands, shutdown guidance, AI SDK telemetry examples, and
instructions for apps that already own OpenTelemetry provider setup.

Install the tools you want to monitor as peers. For the AI SDK harness example:

```sh
npm install ai @ai-sdk/otel @ai-sdk/harness @ai-sdk/harness-claude-code @ai-sdk/sandbox-vercel
```

```ts
import { HarnessAgent } from "@ai-sdk/harness/agent";
import { claudeCode } from "@ai-sdk/harness-claude-code";
import { createVercelSandbox } from "@ai-sdk/sandbox-vercel";
import { registerOTel, aiSdkIntegration } from "@rawtree/otel";

const rawtree = registerOTel({
  serviceName: "ai-sdk",
  apiKey: process.env.RAWTREE_API_KEY!,
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
  await rawtree.shutdown();
}
```

OpenTelemetry trace spans are sent to RawTree as OTLP JSON through
`transform=otlp-traces`. RawTree stores one row per span in the `traces` table,
with the original span fields plus merged resource attributes such as
`service.name` and `scope.name`. Future log and metric exporters should follow
the same signal naming convention with `logs` and `metrics` tables by default.

The monitoring client is also available for manual events:

```ts
import { initRawTree } from "@rawtree/otel";

const monitor = initRawTree({
  apiKey: process.env.RAWTREE_API_KEY!,
  table: "events",
});

monitor.capture("checkout.started", {
  userId: "u_123",
});

await monitor.span("billing.charge", async () => {
  await chargeCustomer();
});

await monitor.flush();
```

See `examples/ai-sdk` for the AI SDK canary `HarnessAgent` flow with Claude
Code running in Vercel Sandbox. It expects `RAWTREE_API_KEY`, plus whatever
credentials your Claude Code and Vercel Sandbox setup require.

## API

```ts
new RawTree({
  apiKey: string;
  database?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
});
```

The SDK sends the API key as `Authorization: Bearer <apiKey>`.
Set `database` on the client for a default database, or override it on an
individual request. The SDK sends the selected database as
`x-rawtree-database`.

### query

```ts
rawtree.query<Row = unknown>(params: QueryParams): Promise<QueryResponse<Row>>;

interface QueryParams extends RequestOptions {
  sql: string;
}
```

### insert

```ts
rawtree.insert<Row extends JsonObject = JsonObject>(
  params: InsertParams<Row>,
): Promise<InsertResponse>;

interface InsertParams<Row extends JsonObject = JsonObject> extends RequestOptions {
  table: string;
  values: Row | Row[];
  transform?: string;
}
```

`InsertParams.transform` can be used with built-in RawTree transforms such as
`otlp-traces`, `otlp-logs`, and `otlp-metrics`.

### tables

```ts
rawtree.tables.list(options?: RequestOptions): Promise<TablesResponse>;
rawtree.tables.describe(params: DescribeTableParams): Promise<DescribeTableResponse>;
```
