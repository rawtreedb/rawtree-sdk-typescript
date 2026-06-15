import { HarnessAgent } from "@ai-sdk/harness/agent";
import { claudeCode } from "@ai-sdk/harness-claude-code";
import { createVercelSandbox } from "@ai-sdk/sandbox-vercel";
import { tool } from "ai";
import { z } from "zod";
import { registerOTel, aiSdkIntegration } from "@rawtree/otel";

const rawtreeApiKey = process.env.RAWTREE_API_KEY;

if (!rawtreeApiKey) {
  throw new Error("Set RAWTREE_API_KEY before running this example.");
}

if (!process.env.AI_GATEWAY_API_KEY && process.env.VERCEL_AI_GATEWAY_API_KEY) {
  process.env.AI_GATEWAY_API_KEY = process.env.VERCEL_AI_GATEWAY_API_KEY;
}

const rawtree = registerOTel({
  serviceName: "rawtree-ai-sdk-example",
  apiKey: rawtreeApiKey,
  environment: process.env.NODE_ENV ?? "development",
  integrations: [
    aiSdkIntegration(),
  ],
});

const agent = new HarnessAgent({
  id: "rawtree-ai-sdk-example",
  harness: claudeCode,
  sandbox: createVercelSandbox({
    runtime: "node24",
    ports: [4000],
  }),
  instructions: [
    "You are testing RawTree telemetry for AI SDK harness agents.",
    "Use the provided tools before answering.",
    "Keep the final answer short and include one concrete next step.",
  ].join(" "),
  tools: {
    getIncident: tool({
      description:
        "Fetch a simulated production incident for the agent to inspect.",
      inputSchema: z.object({
        incidentId: z.string(),
      }),
      execute: async ({ incidentId }) => ({
        incidentId,
        severity: "warning",
        service: "checkout-api",
        startedAt: "2026-06-14T15:20:00.000Z",
        symptoms: [
          "p95 latency increased from 180ms to 740ms",
          "error rate increased to 2.1%",
          "slow requests correlate with inventory reservation retries",
        ],
      }),
    }),
    searchRunbook: tool({
      description: "Search internal runbooks for incident response guidance.",
      inputSchema: z.object({
        query: z.string(),
      }),
      execute: async ({ query }) => ({
        query,
        results: [
          {
            title: "Checkout latency triage",
            summary:
              "Check retry volume, downstream inventory latency, and recent deploys.",
          },
          {
            title: "Inventory reservation retries",
            summary:
              "Reduce retry fanout and verify idempotency keys before rolling back.",
          },
        ],
      }),
    }),
  },
  telemetry: {
    recordInputs: true,
    recordOutputs: true,
    functionId: "ai-sdk-example",
  },
  debug: {
    enabled: true,
    level: "info",
  },
});

const session = await agent.createSession();

try {
  const result = await agent.stream({
    session,
    prompt: [
      "Investigate incident inc_checkout_latency_2026_06_14.",
      "Use getIncident and searchRunbook, then suggest a minimal mitigation plan.",
    ].join(" "),
  });

  for await (const part of result.fullStream) {
    if (part.type === "text-delta") {
      process.stdout.write(part.text);
    }
  }

  process.stdout.write("\n");
} finally {
  await session.destroy();
  await rawtree.shutdown();
}
