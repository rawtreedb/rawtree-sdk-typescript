# RawTree AI SDK Harness Agent Example

This example tries the AI SDK canary harness APIs from Vercel with RawTree telemetry:

- `HarnessAgent` from `@ai-sdk/harness/agent`
- `claudeCode` from `@ai-sdk/harness-claude-code`
- `createVercelSandbox` from `@ai-sdk/sandbox-vercel`

It sends these event families to RawTree:

- `ai.sdk.start`
- `ai.sdk.harness`
- `ai.sdk.model_call.start`
- `ai.sdk.model_call.end`
- `ai.sdk.tool_call.start`
- `ai.sdk.tool_call`

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
