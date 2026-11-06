# RawTree TypeScript SDK

> Experimental: this SDK is early and its public API may change before a stable release.

TypeScript packages for building apps with RawTree.

## Packages

- `@rawtree/sdk`: RawTree API client, generated from the RawTree OpenAPI spec.
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
const workflows = await rawtree.workflows.list();
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
`transform=otlp-traces`. RawTree stores one row per span in the `traces` table
by default (pass `table` to `registerOTel()` to use another table), with the
original span fields plus merged resource attributes such as `service.name` and
`scope.name`. The exporter sends traces only. AI SDK telemetry records full
prompts and model outputs by default. See `packages/otel/README.md` for how to
turn that off with `recordInputs: false` and `recordOutputs: false`. Future log
and metric exporters should follow the same signal naming convention with
`logs` and `metrics` tables by default.

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

See `examples/ai-sdk` for the AI SDK `HarnessAgent` flow with Claude
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

The SDK sends the API key as `Authorization: Bearer <apiKey>`. It covers every
API operation that accepts an API key. Operations that need a user session
aren't included.

Methods follow the API's operation IDs: `tables.describe` is
`rawtree.tables.describe()`, `workflows.runs.list` is
`rawtree.workflows.runs.list()`. Each method takes one object with the
operation's path, query and body fields, plus an optional second argument for
per-request options such as `signal` and `headers`.

```ts
const controller = new AbortController();

await rawtree.databases.create({ name: "analytics" });
await rawtree.tables.list({}, { signal: controller.signal });
```

Set `database` on the client for a default database. The SDK sends it as the
`?database=<name>` query parameter on operations that take a database, unless
the call passes its own `database`.

Failed requests throw `RawTreeError`, with the HTTP `status` and the API's
`error`, `message` and `hint`.

### query

`rawtree.query()` is a shorthand for `rawtree.query.run()`. Pass a row type to
type `data`.

```ts
const result = await rawtree.query<{ event: string }>({
  sql: "SELECT event FROM events",
});

const { formatted } = await rawtree.query.format({ sql: "select 1" });
```

### insert

`rawtree.insert()` is a shorthand for `rawtree.tables.insert()` that takes the
rows as `values` instead of `body`. Pass one JSON object or an array of them.

```ts
await rawtree.insert({
  table: "events",
  values: [{ event: "signup", user_id: "u_123" }],
});

await rawtree.insert({
  table: "traces",
  values: otlpTraceExport,
  transform: "otlp-traces",
});
```

`transform` accepts built-in RawTree transforms such as `otlp-traces`,
`otlp-logs`, and `otlp-metrics`.

## Development

`packages/sdk/src/generated` is generated from the RawTree OpenAPI spec with
[Hey API](https://heyapi.dev). Don't edit it by hand: change
`packages/sdk/openapi-ts.config.ts` or the hand-written wrapper in
`packages/sdk/src/index.ts`, then regenerate.

Regenerate from the production spec at `https://api.rawtree.com/v1/openapi.json`:

```sh
npm run generate
```

Point `RAWTREE_OPENAPI_URL` at another spec, such as a local stack or a saved
file:

```sh
RAWTREE_OPENAPI_URL=http://localhost:8082/v1/openapi.json npm run generate
RAWTREE_OPENAPI_URL=./openapi.json npm run generate
```

Then build, typecheck, and test, and commit the generated code with your change:

```sh
npm run build && npm run typecheck && npm test
```
