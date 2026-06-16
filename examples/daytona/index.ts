import { Daytona } from "@daytona/sdk";
import { daytonaIntegration, registerOTel } from "@rawtree/otel";

const rawtreeApiKey = process.env.RAWTREE_API_KEY;
const daytonaApiKey = process.env.DAYTONA_API_KEY;

if (!rawtreeApiKey) {
  throw new Error("Set RAWTREE_API_KEY before running this example.");
}

if (!daytonaApiKey) {
  throw new Error("Set DAYTONA_API_KEY before running this example.");
}

const rawtree = registerOTel({
  apiKey: rawtreeApiKey,
  serviceName: "rawtree-daytona-example",
  environment: process.env.NODE_ENV ?? "development",
  integrations: [
    daytonaIntegration(),
  ],
});

const daytona = new Daytona({
  apiKey: daytonaApiKey,
  apiUrl: process.env.DAYTONA_API_URL,
  target: process.env.DAYTONA_TARGET,
});

let sandbox: Awaited<ReturnType<typeof daytona.create>> | undefined;

try {
  sandbox = await daytona.create({
    language: "typescript",
  });

  const response = await sandbox.process.codeRun(
    'console.log("Hello World from Daytona!")',
  );

  console.log(response.result);
} finally {
  if (sandbox) {
    await daytona.delete(sandbox).catch((error: unknown) => {
      console.warn("Failed to delete Daytona sandbox.", error);
    });
  }

  try {
    await daytona[Symbol.asyncDispose]();
  } finally {
    await rawtree.shutdown();
  }
}
