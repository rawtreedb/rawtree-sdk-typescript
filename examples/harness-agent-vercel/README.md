# RawTree AI SDK Harness Agent Example

This example tries the AI SDK canary harness APIs from Vercel with RawTree
telemetry. RawTree bridges AI SDK canary telemetry into OpenTelemetry spans
before ingestion.

- `HarnessAgent` from `@ai-sdk/harness/agent`
- `claudeCode` from `@ai-sdk/harness-claude-code`
- `createVercelSandbox` from `@ai-sdk/sandbox-vercel`

It sends these event families to RawTree:

- `ai.sdk.invoke_agent`
- `ai.sdk.generate_content`
- `ai.sdk.execute_tool`

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
export RAWTREE_TABLE=events
```

You will also need Vercel Sandbox auth and Claude Code model auth. For Vercel AI
Gateway, either `AI_GATEWAY_API_KEY` or `VERCEL_AI_GATEWAY_API_KEY` works.
