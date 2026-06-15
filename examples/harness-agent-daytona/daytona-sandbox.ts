import {
  Daytona,
  DaytonaNotFoundError,
  Sandbox,
  type CreateSandboxFromImageParams,
  type CreateSandboxFromSnapshotParams,
  type DaytonaConfig,
} from "@daytona/sdk";
import type {
  HarnessV1NetworkSandboxSession,
  HarnessV1SandboxProvider,
} from "@ai-sdk/harness";
import type {
  Experimental_SandboxProcess,
  Experimental_SandboxSession,
} from "@ai-sdk/provider-utils";
import { randomUUID } from "node:crypto";

type DaytonaCreateParams =
  | CreateSandboxFromSnapshotParams
  | CreateSandboxFromImageParams;

export interface DaytonaSandboxSettings {
  config?: DaytonaConfig;
  create?: DaytonaCreateParams;
  sandbox?: Sandbox;
  ports?: ReadonlyArray<number>;
  namePrefix?: string;
  defaultWorkingDirectory?: string;
  signedPreviewExpiresInSeconds?: number;
  createTimeoutSeconds?: number;
  startTimeoutSeconds?: number;
  deleteTimeoutSeconds?: number;
  ensurePnpm?: boolean;
  pnpmVersion?: string;
}

const DEFAULT_PORTS = [4000];
const DEFAULT_NAME_PREFIX = "rawtree-harness";
const DEFAULT_PREVIEW_EXPIRES_IN_SECONDS = 60 * 60;
const DEFAULT_WORKING_DIRECTORY = "/home/daytona";
const DEFAULT_PNPM_VERSION = "10.14.0";

export function createDaytonaSandbox(
  settings: DaytonaSandboxSettings = {},
): HarnessV1SandboxProvider {
  const daytona = settings.sandbox ? undefined : new Daytona(settings.config);

  return {
    specificationVersion: "harness-sandbox-v1",
    providerId: "daytona",

    async createSession(options = {}) {
      const acquired = settings.sandbox
        ? { sandbox: settings.sandbox, isFresh: false }
        : await getOrCreateSandbox(daytona!, settings, options.sessionId);

      const session = await toHarnessSandboxSession(acquired.sandbox, settings);

      if (settings.ensurePnpm ?? true) {
        await ensurePnpm(session.restricted(), settings, options.abortSignal);
      }

      if (acquired.isFresh) {
        await options.onFirstCreate?.(session.restricted(), {
          abortSignal: options.abortSignal,
        });
      }

      return session;
    },

    async resumeSession(options) {
      if (settings.sandbox) {
        return toHarnessSandboxSession(settings.sandbox, settings);
      }

      const sandbox = await daytona!.get(toSandboxName(settings, options.sessionId));
      await ensureStarted(sandbox, settings);
      const session = await toHarnessSandboxSession(sandbox, settings);

      if (settings.ensurePnpm ?? true) {
        await ensurePnpm(session.restricted(), settings, options.abortSignal);
      }

      return session;
    },
  };
}

async function getOrCreateSandbox(
  daytona: Daytona,
  settings: DaytonaSandboxSettings,
  sessionId: string | undefined,
): Promise<{ sandbox: Sandbox; isFresh: boolean }> {
  const name = sessionId ? toSandboxName(settings, sessionId) : undefined;

  if (name) {
    const existing = await tryGetSandbox(daytona, name);

    if (existing) {
      await ensureStarted(existing, settings);
      return { sandbox: existing, isFresh: false };
    }
  }

  const sandbox = await daytona.create({
    language: "typescript",
    autoDeleteInterval: 0,
    ...(settings.create ?? {}),
    ...(name ? { name } : {}),
  } as DaytonaCreateParams, {
    timeout: settings.createTimeoutSeconds,
  });

  await ensureStarted(sandbox, settings);
  return { sandbox, isFresh: true };
}

async function tryGetSandbox(
  daytona: Daytona,
  name: string,
): Promise<Sandbox | undefined> {
  try {
    return await daytona.get(name);
  } catch (error) {
    if (isNotFoundError(error)) {
      return undefined;
    }

    throw error;
  }
}

async function ensureStarted(
  sandbox: Sandbox,
  settings: DaytonaSandboxSettings,
): Promise<void> {
  await sandbox.refreshData().catch(() => undefined);

  if (sandbox.state !== "started") {
    await sandbox.start(settings.startTimeoutSeconds);
  }
}

async function toHarnessSandboxSession(
  sandbox: Sandbox,
  settings: DaytonaSandboxSettings,
): Promise<HarnessV1NetworkSandboxSession> {
  const defaultWorkingDirectory = settings.defaultWorkingDirectory
    ?? await sandbox.getWorkDir()
    ?? await sandbox.getUserHomeDir()
    ?? DEFAULT_WORKING_DIRECTORY;
  const ports = [...(settings.ports ?? DEFAULT_PORTS)];
  const restricted = createRestrictedSession({
    sandbox,
    defaultWorkingDirectory,
    ports,
  });

  return {
    ...restricted,
    id: sandbox.id,
    defaultWorkingDirectory,
    ports,
    async getPortUrl(options) {
      const signed = await sandbox.getSignedPreviewUrl(
        options.port,
        settings.signedPreviewExpiresInSeconds ?? DEFAULT_PREVIEW_EXPIRES_IN_SECONDS,
      );

      return toRequestedProtocol(signed.url, options.protocol);
    },
    async stop() {
      await sandbox.stop(settings.startTimeoutSeconds).catch(() => undefined);
    },
    async destroy() {
      await sandbox.delete(settings.deleteTimeoutSeconds).catch(() => undefined);
    },
    async setPorts(nextPorts) {
      ports.splice(0, ports.length, ...nextPorts);
    },
    restricted() {
      return restricted;
    },
  };
}

async function ensurePnpm(
  session: Experimental_SandboxSession,
  settings: DaytonaSandboxSettings,
  abortSignal: AbortSignal | undefined,
): Promise<void> {
  const pnpmVersion = settings.pnpmVersion ?? DEFAULT_PNPM_VERSION;

  if (!/^[\w.+-]+$/.test(pnpmVersion)) {
    throw new Error(`Invalid pnpm version: ${pnpmVersion}`);
  }

  const result = await session.run({
    command: `command -v pnpm >/dev/null 2>&1 || npm install -g pnpm@${pnpmVersion}`,
    abortSignal,
  });

  if (result.exitCode !== 0) {
    throw new Error([
      `Failed to prepare pnpm@${pnpmVersion} in Daytona sandbox.`,
      result.stderr || result.stdout,
    ].filter(Boolean).join(" "));
  }
}

function createRestrictedSession(options: {
  sandbox: Sandbox;
  defaultWorkingDirectory: string;
  ports: ReadonlyArray<number>;
}): Experimental_SandboxSession {
  const { sandbox, defaultWorkingDirectory, ports } = options;

  return {
    description: [
      "Daytona sandbox.",
      `Sandbox id: ${sandbox.id}.`,
      `Default working directory: ${defaultWorkingDirectory}.`,
      `Preview ports: ${ports.join(", ")}.`,
    ].join(" "),

    async readFile(readOptions) {
      const bytes = await readBinaryFile(sandbox, readOptions.path);
      return bytes ? bytesToReadableStream(bytes) : null;
    },

    async readBinaryFile(readOptions) {
      return readBinaryFile(sandbox, readOptions.path);
    },

    async readTextFile(readOptions) {
      const bytes = await readBinaryFile(sandbox, readOptions.path);

      if (!bytes) {
        return null;
      }

      const text = new TextDecoder(readOptions.encoding ?? "utf-8").decode(bytes);
      return sliceLines(text, readOptions.startLine, readOptions.endLine);
    },

    async writeFile(writeOptions) {
      const bytes = await readableStreamToBytes(writeOptions.content);
      await writeBinaryFile(sandbox, writeOptions.path, bytes);
    },

    async writeBinaryFile(writeOptions) {
      await writeBinaryFile(sandbox, writeOptions.path, writeOptions.content);
    },

    async writeTextFile(writeOptions) {
      const bytes = new TextEncoder().encode(writeOptions.content);
      await writeBinaryFile(sandbox, writeOptions.path, bytes);
    },

    async run(processOptions) {
      const sessionId = `rawtree-run-${randomUUID()}`;

      try {
        await sandbox.process.createSession(sessionId);
        const result = await sandbox.process.executeSessionCommand(sessionId, {
          command: buildShellCommand(processOptions),
          runAsync: false,
          suppressInputEcho: true,
        } as never);

        return {
          exitCode: result.exitCode ?? 0,
          stdout: result.stdout ?? result.output ?? "",
          stderr: result.stderr ?? "",
        };
      } finally {
        await sandbox.process.deleteSession(sessionId).catch(() => undefined);
      }
    },

    async spawn(processOptions) {
      return spawnProcess(sandbox, processOptions);
    },
  };
}

async function spawnProcess(
  sandbox: Sandbox,
  processOptions: Parameters<Experimental_SandboxSession["spawn"]>[0],
): Promise<Experimental_SandboxProcess> {
  const sessionId = `rawtree-spawn-${randomUUID()}`;
  const stdout = createWritableReadableStream();
  const stderr = createWritableReadableStream();
  let closed = false;

  await sandbox.process.createSession(sessionId);

  const command = await sandbox.process.executeSessionCommand(sessionId, {
    command: buildShellCommand(processOptions),
    runAsync: true,
    suppressInputEcho: true,
  } as never);
  const commandId = command.cmdId;

  if (!commandId) {
    await sandbox.process.deleteSession(sessionId).catch(() => undefined);
    throw new Error("Daytona did not return a command id for spawned process.");
  }

  const logsDone = sandbox.process.getSessionCommandLogs(
    sessionId,
    commandId,
    (chunk) => stdout.write(chunk),
    (chunk) => stderr.write(chunk),
  ).finally(() => {
    stdout.close();
    stderr.close();
  });

  const cleanup = async (): Promise<void> => {
    if (closed) {
      return;
    }

    closed = true;
    await sandbox.process.deleteSession(sessionId).catch(() => undefined);
  };

  processOptions.abortSignal?.addEventListener("abort", () => {
    void cleanup();
  }, { once: true });

  return {
    stdout: stdout.stream,
    stderr: stderr.stream,
    async wait() {
      await logsDone;
      const finished = await sandbox.process
        .getSessionCommand(sessionId, commandId)
        .catch(() => undefined);
      await cleanup();

      return {
        exitCode: finished?.exitCode ?? command.exitCode ?? 0,
      };
    },
    async kill() {
      await cleanup();
    },
  };
}

async function readBinaryFile(
  sandbox: Sandbox,
  path: string,
): Promise<Uint8Array | null> {
  try {
    const buffer = await sandbox.fs.downloadFile(path);
    return new Uint8Array(buffer);
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }

    throw error;
  }
}

async function writeBinaryFile(
  sandbox: Sandbox,
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  await sandbox.process.executeCommand(`mkdir -p ${shellQuote(dirname(path))}`);
  await sandbox.fs.uploadFile(Buffer.from(bytes), path);
}

function createWritableReadableStream(): {
  stream: ReadableStream<Uint8Array>;
  write: (chunk: string) => void;
  close: () => void;
} {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const queue: Uint8Array[] = [];
  let isClosed = false;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(nextController) {
      controller = nextController;
      for (const chunk of queue.splice(0)) {
        controller.enqueue(chunk);
      }
    },
  });

  return {
    stream,
    write(chunk) {
      if (isClosed) {
        return;
      }

      const bytes = encoder.encode(chunk);

      if (controller) {
        controller.enqueue(bytes);
      } else {
        queue.push(bytes);
      }
    },
    close() {
      if (isClosed) {
        return;
      }

      isClosed = true;
      controller?.close();
    },
  };
}

async function readableStreamToBytes(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      chunks.push(value);
      totalLength += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalLength);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
}

function bytesToReadableStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function sliceLines(
  text: string,
  startLine = 1,
  endLine?: number,
): string {
  if (startLine <= 1 && endLine === undefined) {
    return text;
  }

  const lines = text.split("\n");
  const start = Math.max(0, startLine - 1);
  const end = endLine === undefined ? lines.length : Math.max(start, endLine);
  return lines.slice(start, end).join("\n");
}

function buildShellCommand(options: {
  command: string;
  workingDirectory?: string;
  env?: Record<string, string>;
}): string {
  const cd = options.workingDirectory
    ? `cd ${shellQuote(options.workingDirectory)} && `
    : "";
  const env = Object.entries(options.env ?? {})
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(" ");
  const envPrefix = env ? `env ${env} ` : "";

  return `${cd}${envPrefix}sh -lc ${shellQuote(options.command)}`;
}

function toRequestedProtocol(url: string, protocol?: "http" | "https" | "ws"): string {
  const parsed = new URL(url);

  if (protocol === "ws") {
    parsed.protocol = parsed.protocol === "http:" ? "ws:" : "wss:";
  } else if (protocol === "http") {
    parsed.protocol = "http:";
  } else if (protocol === "https") {
    parsed.protocol = "https:";
  }

  return parsed.toString();
}

function toSandboxName(
  settings: DaytonaSandboxSettings,
  sessionId: string,
): string {
  const prefix = settings.namePrefix ?? DEFAULT_NAME_PREFIX;
  const rawName = `${prefix}-${sessionId}`.toLowerCase();
  return rawName.replace(/[^a-z0-9-]/g, "-").slice(0, 63);
}

function dirname(path: string): string {
  const normalized = path.replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");

  if (index <= 0) {
    return ".";
  }

  return normalized.slice(0, index);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function isNotFoundError(error: unknown): boolean {
  if (error instanceof DaytonaNotFoundError) {
    return true;
  }

  if (error instanceof Error) {
    return /not found|404/i.test(error.message);
  }

  return false;
}
