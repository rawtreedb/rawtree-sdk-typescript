# RawTree AI SDK Example

This example tries the AI SDK canary harness APIs with RawTree telemetry. It
installs `@ai-sdk/otel`, and `aiSdkIntegration()` registers AI SDK's official
OpenTelemetry integration. `registerOTel()` installs RawTree as the span
exporter, so every OpenTelemetry span in the process can be sent to RawTree.

- `HarnessAgent` from `@ai-sdk/harness/agent`
- `claudeCode` from `@ai-sdk/harness-claude-code`
- `createVercelSandbox` from `@ai-sdk/sandbox-vercel`

It sends this signal to RawTree:

- OTLP trace spans through `transform=otlp-traces`, stored as one row per span
  in the `traces` table, or in `RAWTREE_TABLE` when set

The agent uses the AI SDK 7 `telemetry` option. AI SDK records full prompts and
model outputs by default (`gen_ai.input.messages` and `gen_ai.output.messages`).
Add `recordInputs: false` and `recordOutputs: false` to the agent's `telemetry`
options to keep that text out of RawTree.

The harness packages are canary/experimental, so expect churn.

## Run

```sh
npm install
npm run start
```

`npm run start` loads `.env.local` when present.

Required environment:

```sh
export RAWTREE_API_KEY=...
```

Optional environment:

```sh
export RAWTREE_TABLE=ai_traces # defaults to traces
```

You will also need Vercel Sandbox auth and Claude Code model auth. For Vercel AI
Gateway, either `AI_GATEWAY_API_KEY` or `VERCEL_AI_GATEWAY_API_KEY` works.
