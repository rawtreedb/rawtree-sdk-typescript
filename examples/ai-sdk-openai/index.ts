import { generateText, stepCountIs, tool } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import { initRawTree } from "@rawtree/sdk/monitoring";
import { aiSdkIntegration } from "@rawtree/sdk/integrations/ai-sdk";

const rawtreeApiKey = process.env.RAWTREE_API_KEY;

if (!rawtreeApiKey) {
  throw new Error("Set RAWTREE_API_KEY before running this example.");
}

if (!process.env.OPENAI_API_KEY) {
  throw new Error("Set OPENAI_API_KEY before running this example.");
}

const rawtree = initRawTree({
  apiKey: rawtreeApiKey,
  table: process.env.RAWTREE_TABLE ?? "events",
  service: "rawtree-ai-sdk-example",
  environment: process.env.NODE_ENV ?? "development",
  integrations: [
    aiSdkIntegration({
      captureInputs: true,
      captureOutputs: true,
    }),
  ],
});

try {
  const result = await generateText({
    model: openai(process.env.OPENAI_MODEL ?? "gpt-5.3-codex"),
    prompt: [
      "You are a support engineer preparing a customer health summary.",
      "Use the CRM, usage, and docs tools before answering.",
      "Summarize whether customer acme-co is healthy and suggest one next action.",
    ].join(" "),
    tools: {
      getCustomerProfile: tool({
        description: "Look up a customer's plan, owner, and current status.",
        inputSchema: z.object({
          customerId: z.string(),
        }),
        execute: async ({ customerId }) => ({
          customerId,
          name: "Acme Co",
          plan: "growth",
          owner: "Maya",
          status: "active",
          openTickets: 2,
        }),
      }),
      getUsageMetrics: tool({
        description: "Fetch recent product usage metrics for a customer.",
        inputSchema: z.object({
          customerId: z.string(),
          days: z.number().int().min(1).max(30),
        }),
        execute: async ({ customerId, days }) => ({
          customerId,
          days,
          ingestedEvents: 128_450,
          queriesRun: 312,
          failedIngests: 3,
          p95QueryMs: 184,
        }),
      }),
      searchDocs: tool({
        description: "Search RawTree docs for guidance relevant to a customer question.",
        inputSchema: z.object({
          query: z.string(),
        }),
        execute: async ({ query }) => ({
          query,
          results: [
            {
              title: "Ingest unstructured JSON",
              summary: "Send arbitrary JSON rows to a table and query them later.",
            },
            {
              title: "Investigate failed inserts",
              summary: "Use RawTree logs filtered by insert status and table.",
            },
          ],
        }),
      }),
    },
    stopWhen: stepCountIs(4),
    experimental_telemetry: {
      isEnabled: true,
      recordInputs: true,
      recordOutputs: true,
    },
  });

  console.log(result.text);
} finally {
  await rawtree.flush();
}
