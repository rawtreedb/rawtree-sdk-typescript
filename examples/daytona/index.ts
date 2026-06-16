import { Daytona } from "@daytona/sdk";
import { configureDaytonaOtel } from "@rawtree/otel/daytona";

const rawtreeApiKey = process.env.RAWTREE_API_KEY;
const daytonaApiKey = process.env.DAYTONA_API_KEY;

if (!rawtreeApiKey) {
  throw new Error("Set RAWTREE_API_KEY before running this example.");
}

if (!daytonaApiKey) {
  throw new Error("Set DAYTONA_API_KEY before running this example.");
}

const daytonaOtel = configureDaytonaOtel({
  apiKey: rawtreeApiKey,
  tracesTable: process.env.RAWTREE_DAYTONA_TRACES_TABLE,
  metricsTable: process.env.RAWTREE_DAYTONA_METRICS_TABLE,
});

const daytona = new Daytona({
  apiKey: daytonaApiKey,
  apiUrl: process.env.DAYTONA_API_URL,
  target: process.env.DAYTONA_TARGET,
  otelEnabled: true,
});

let sandbox: Awaited<ReturnType<typeof daytona.create>> | undefined;

try {
  sandbox = await daytona.create({
    language: "typescript",
    ephemeral: true,
    autoStopInterval: 5,
    labels: {
      example: "rawtree-daytona",
    },
  });

  const response = await sandbox.process.executeCommand(
    'node -e "console.log(JSON.stringify({ ok: true, source: \\"daytona\\" }))"',
  );

  console.log(response.result);
} finally {
  if (sandbox) {
    await daytona.delete(sandbox).catch((error: unknown) => {
      console.warn("Failed to delete Daytona sandbox.", error);
    });
  }

  await daytona[Symbol.asyncDispose]();
  daytonaOtel.shutdown();
}
