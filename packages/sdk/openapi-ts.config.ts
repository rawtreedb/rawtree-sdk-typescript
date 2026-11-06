import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "@hey-api/openapi-ts";

const source = process.env.RAWTREE_OPENAPI_URL ?? "https://api.rawtree.com/v1/openapi.json";
const spec = /^https?:\/\//.test(source)
  ? await fetch(source).then((response) => {
      if (!response.ok) throw new Error(`GET ${source} failed with status ${response.status}`);
      return response.json();
    })
  : // npm runs this from packages/sdk; resolve file paths from where the command was run.
    JSON.parse(readFileSync(resolve(process.env.INIT_CWD ?? process.cwd(), source), "utf8"));

// Inline request-body $refs so flat params spread body fields into the call object.
for (const item of Object.values<any>(spec.paths)) {
  for (const op of Object.values<any>(item)) {
    const content = op?.requestBody?.content?.["application/json"];
    const ref: string | undefined = content?.schema?.$ref;
    if (ref) content.schema = { ...spec.components.schemas[ref.split("/").pop()!] };
  }
}

// The SDK authenticates with API keys, so publish only operations that accept one.
const apiKeyOperations = Object.entries<any>(spec.paths).flatMap(([path, item]) =>
  Object.entries<any>(item)
    .filter(([, op]) => !op.security || op.security.some((s: object) => "apiKeyAuth" in s))
    .map(([method]) => `${method.toUpperCase()} ${path}`),
);

// The client's default database applies only to operations that take a `database` parameter.
const databaseOperations = apiKeyOperations.filter((operation) => {
  const [method, path] = operation.split(" ");
  return spec.paths[path][method.toLowerCase()].parameters?.some(
    (p: any) => p.in === "query" && p.name === "database",
  );
});
writeFileSync(
  "src/database-operations.gen.ts",
  `// Generated from the OpenAPI spec by openapi-ts.config.ts.\nexport const databaseOperations: ReadonlySet<string> = new Set(${JSON.stringify(databaseOperations, null, 2)});\n`,
);

export default defineConfig({
  input: spec,
  parser: { filters: { operations: { include: apiKeyOperations } } },
  output: { path: "src/generated", module: { extension: ".js" } },
  plugins: [
    "@hey-api/typescript",
    { name: "@hey-api/client-fetch", throwOnError: true },
    {
      name: "@hey-api/sdk",
      operations: { strategy: "single", containerName: "RawTreeApi", nesting: "operationId" },
      paramsStructure: "flat",
      responseStyle: "data",
    },
  ],
});
