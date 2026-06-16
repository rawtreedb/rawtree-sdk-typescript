import type {
  RawTreeIntegration,
} from "../client.js";

const DAYTONA_OTEL_ENABLED = "DAYTONA_OTEL_ENABLED";
const DAYTONA_EXPERIMENTAL_OTEL_ENABLED = "DAYTONA_EXPERIMENTAL_OTEL_ENABLED";

const DAYTONA_OTEL_ENV_KEYS = [
  DAYTONA_OTEL_ENABLED,
  DAYTONA_EXPERIMENTAL_OTEL_ENABLED,
] as const;

export function daytonaIntegration(): RawTreeIntegration {
  return {
    name: "daytona",
    setupOtel() {
      const previousEnvironment = snapshotEnvironment(DAYTONA_OTEL_ENV_KEYS);

      process.env[DAYTONA_OTEL_ENABLED] = "false";
      process.env[DAYTONA_EXPERIMENTAL_OTEL_ENABLED] = "false";

      return () => {
        restoreEnvironment(previousEnvironment);
      };
    },
  };
}

function snapshotEnvironment(
  keys: readonly string[],
): Map<string, string | undefined> {
  return new Map(keys.map((key) => [key, process.env[key]]));
}

function restoreEnvironment(previousEnvironment: Map<string, string | undefined>): void {
  for (const [key, value] of previousEnvironment) {
    if (value === undefined) {
      delete process.env[key];
      continue;
    }

    process.env[key] = value;
  }
}
