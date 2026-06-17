import { defineInstrumentation } from "eve/instrumentation";
import { registerOTel } from "@rawtree/otel";

const rawtreeApiKey = process.env.RAWTREE_API_KEY;

if (!rawtreeApiKey) {
  throw new Error("Set RAWTREE_API_KEY before running this example.");
}

export default defineInstrumentation({
  setup: ({ agentName }) => {
    registerOTel({
      apiKey: rawtreeApiKey,
      serviceName: agentName,
      environment: process.env.NODE_ENV ?? "development",
      spanProcessor: "simple",
    });
  },
  recordInputs: true,
  recordOutputs: true,
});
