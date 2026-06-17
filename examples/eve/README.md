# RawTree Eve Example

This example sends Eve agent OpenTelemetry spans to RawTree using Eve's public
`agent/instrumentation.ts` API and RawTree's `registerOTel()`.

Eve owns the AI SDK telemetry setup. This example only registers RawTree as the
OpenTelemetry exporter:

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
npm run dev
```

Eve loads `.env` and `.env.local` from the example root.

Required environment:

```sh
export RAWTREE_API_KEY=...
export AI_GATEWAY_API_KEY=...
```

You can also use `VERCEL_OIDC_TOKEN` for AI Gateway auth if you pulled it with
`eve link` or `vercel link`.

Optional environment:

```sh
export EVE_MODEL=anthropic/claude-sonnet-4.6
```

In another terminal, create a session with Eve's built-in HTTP API:

```sh
curl -X POST http://127.0.0.1:3000/eve/v1/session \
  -H 'content-type: application/json' \
  -d '{"message":"Say hello from RawTree in one short sentence."}'
```

Then attach to the session stream with the `x-eve-session-id` response header:

```sh
curl http://127.0.0.1:3000/eve/v1/session/<sessionId>/stream
```

After the run completes, query RawTree's `traces` table for
`service.name = 'rawtree-eve-example'`.
