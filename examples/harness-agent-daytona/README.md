# RawTree AI SDK Harness Agent Daytona Example

This example runs the AI SDK canary `HarnessAgent` with Claude Code in a Daytona
sandbox while sending AI SDK telemetry and Daytona OpenTelemetry spans to
RawTree. It installs `@ai-sdk/otel`, and `aiSdkIntegration()` registers AI SDK's
official OpenTelemetry integration before RawTree ingests the spans.

It sends these event types to RawTree:

- `ai.sdk.otel.span`
- `daytona.otel.span`

The Daytona adapter in this folder is intentionally example-local while the AI
SDK harness APIs are canary/experimental. The RawTree Daytona integration
uses RawTree's shared in-process OpenTelemetry provider, so do not pass Daytona
`config: { otelEnabled: true }` for this example. That Daytona flag starts
Daytona's own OTLP exporter, which is useful for collector setups but not needed
for the Sentry-style RawTree integration.

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
export DAYTONA_API_KEY=...
```

You will also need Claude Code model auth. For Vercel AI Gateway, either
`AI_GATEWAY_API_KEY` or `VERCEL_AI_GATEWAY_API_KEY` works.
