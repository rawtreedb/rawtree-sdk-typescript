# RawTree TypeScript SDK

> Experimental: this SDK is early and its public API may change before a stable release.

TypeScript SDK for building apps with RawTree.

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
client, add integrations, and flush events into a RawTree table.

```ts
import { initRawTree } from "@rawtree/sdk/monitoring";
import { aiSdkIntegration } from "@rawtree/sdk/integrations/ai-sdk";
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";

const rawtree = initRawTree({
  apiKey: process.env.RAWTREE_API_KEY!,
  table: "events",
  service: "api",
  environment: "production",
  integrations: [
    aiSdkIntegration({
      captureInputs: false,
      captureOutputs: false,
    }),
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
