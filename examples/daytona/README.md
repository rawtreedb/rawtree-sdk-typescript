# RawTree Daytona Example

This example sends Daytona SDK telemetry to RawTree.

`configureDaytonaOtel()` configures the OTLP environment variables that
Daytona's own exporter reads when `otelEnabled: true` is enabled.

It sends this signal to RawTree:

- Daytona OTLP trace spans through RawTree's native `/otlp/v1/traces` endpoint,
  stored as one row per span in the `traces` table by default
- Daytona OTLP metrics through RawTree's native `/otlp/v1/metrics` endpoint,
  stored in the `metrics` table by default

## Run

```sh
npm install
npm run start
```

`npm run start` loads `.env.local` when present.

Required environment:

```sh
export RAWTREE_API_KEY=...
export DAYTONA_API_KEY=...
```

Optional environment:

```sh
export DAYTONA_API_URL=...
export DAYTONA_TARGET=...
export RAWTREE_DAYTONA_TRACES_TABLE=daytona_traces
export RAWTREE_DAYTONA_METRICS_TABLE=daytona_metrics
```

The example creates an ephemeral TypeScript sandbox, runs one command, deletes
the sandbox, shuts down Daytona's OpenTelemetry SDK, and restores the OTLP
environment variables.
