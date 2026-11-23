import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "@hey-api/openapi-ts";

const source = process.env.RAWTREE_OPENAPI_URL ?? "https://api.765eb5f5.us-east-1.aws.rawtree.com/v1/openapi.json";
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

// Hey API selects a single media type per status. Query responses can be JSON
// or text, so give the TypeScript generator all the documented success schemas.
for (const operation of [spec.paths["/v1/query"].get, spec.paths["/v1/query"].post]) {
  const content = operation.responses["200"].content;
  const mediaTypes = Object.values<{ schema: object }>(content);
  if (mediaTypes.length > 1) {
    content["application/json"] = { schema: { anyOf: mediaTypes.map(({ schema }) => schema) } };
  }
}

// API keys are bound to one organization and cluster, so their selectors can only
// repeat what the key already decides.
const tenantSelectors = new Set([
  "organization",
  "cluster",
  "X-RawTree-Organization-Id",
  "X-RawTree-Cluster-Id",
]);
for (const item of Object.values<any>(spec.paths)) {
  for (const op of Object.values<any>(item)) {
    if (op?.parameters) {
      op.parameters = op.parameters.filter(
        (p: any) => !(["query", "header"].includes(p.in) && tenantSelectors.has(p.name)),
      );
    }
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
