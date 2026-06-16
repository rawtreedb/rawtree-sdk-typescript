# RawTree Daytona Example

This example sends Daytona SDK telemetry to RawTree.

`registerOTel()` installs RawTree as the process OpenTelemetry trace and metric
exporter, and `daytonaIntegration()` lets Daytona SDK telemetry flow through
that same setup.

It sends this signal to RawTree:

- Daytona SDK trace spans through RawTree's `otlp-traces` transform, stored as
  one row per span in the `traces` table by default
- Daytona SDK duration histograms through RawTree's `otlp-metrics` transform,
  stored as one row per metric data point in the `metrics` table by default

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
```

Do not pass `otelEnabled: true` to Daytona in this example. RawTree owns the
OpenTelemetry provider.

The example creates an ephemeral TypeScript sandbox, runs one command, deletes
the sandbox, then shuts down Daytona and RawTree so spans and metrics flush.
