import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { Client } from "eve/client";

const rawtreeApiKey = process.env.RAWTREE_API_KEY;
const gatewayApiKey = process.env.AI_GATEWAY_API_KEY
  ?? process.env.VERCEL_AI_GATEWAY_API_KEY;

if (!rawtreeApiKey) {
  throw new Error("Set RAWTREE_API_KEY before running this example.");
}

if (!gatewayApiKey) {
  throw new Error("Set AI_GATEWAY_API_KEY before running this example.");
}

process.env.AI_GATEWAY_API_KEY = gatewayApiKey;

const port = await getAvailablePort();
const host = `http://127.0.0.1:${port}`;
const server = spawn(
  "npx",
  ["eve", "dev", "--no-ui", "--host", "127.0.0.1", "--port", String(port), "--logs", "stderr"],
  {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  },
);

let output = "";

server.stdout.on("data", (chunk: Buffer) => {
  output += chunk.toString();
});

server.stderr.on("data", (chunk: Buffer) => {
  output += chunk.toString();
});

try {
  await waitForEve(host, server);

  const client = new Client({ host });
  const session = client.session();
  const response = await session.send({
    message: "Say hello in one short sentence.",
  });
  const result = await response.result();

  if (result.status !== "completed" && result.status !== "waiting") {
    throw new Error(`Eve turn finished with unexpected status: ${result.status}`);
  }

  console.log(result.message ?? "Eve completed without a final message.");
} finally {
  server.kill("SIGTERM");
  await Promise.race([
    once(server, "exit"),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
}

async function getAvailablePort(): Promise<number> {
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const address = socket.address();
  socket.close();

  if (!address || typeof address === "string") {
    throw new Error("Could not resolve an available port for Eve.");
  }

  return address.port;
}

async function waitForEve(host: string, child: ReturnType<typeof spawn>): Promise<void> {
  const client = new Client({ host });
  const deadline = Date.now() + 120_000;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Eve dev exited before startup.\n${output}`);
    }

    try {
      await client.health();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  throw new Error(`Timed out waiting for Eve dev to start.\n${output}`);
}
