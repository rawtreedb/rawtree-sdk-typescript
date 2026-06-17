# RawTree Eve Example

This example sends Eve agent OpenTelemetry spans to RawTree using Eve's public
`agent/instrumentation.ts` API and RawTree's `registerOTel()`.

Eve owns the AI SDK telemetry setup. The example only registers RawTree as the
process OpenTelemetry exporter:

```ts
// agent/instrumentation.ts
import { defineInstrumentation } from "eve/instrumentation";
import { registerOTel } from "@rawtree/otel";

export default defineInstrumentation({
  setup: ({ agentName }) => {
    registerOTel({
      apiKey: process.env.RAWTREE_API_KEY!,
      serviceName: agentName,
      spanProcessor: "simple",
    });
  },
  recordInputs: true,
  recordOutputs: true,
});
```

It sends Eve's OpenTelemetry spans to RawTree's `traces` table through the
`otlp-traces` transform. In a local smoke run, Eve emitted workflow spans such
as `workflow.start` and `workflow.run` under this example's service name.

## Run

```sh
npm install
npm run start
```

`npm run start` loads `.env.local` when present.

Required environment:

```sh
export RAWTREE_API_KEY=...
export AI_GATEWAY_API_KEY=...
```

For local compatibility with the other examples, the runner also accepts
`VERCEL_AI_GATEWAY_API_KEY` and forwards it to Eve as `AI_GATEWAY_API_KEY`.

Optional environment:

```sh
export EVE_MODEL=openai/gpt-5-mini
```

The example starts `eve dev --no-ui`, sends one prompt through `eve/client`,
prints the final response, and stops the local Eve server.
