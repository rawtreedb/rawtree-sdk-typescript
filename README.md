# RawTree TypeScript SDK

> Experimental: this SDK is early and its public API may change before a stable release.

TypeScript SDK for building apps with RawTree.

## Install

```sh
npm install @rawtree/sdk
```

## Usage

```ts
import { RawTree } from "@rawtree/sdk";

const rawtree = new RawTree({
  apiKey: process.env.RAWTREE_API_KEY!,
});

await rawtree.insert("events", [
  { event: "signup", user_id: "u_123" },
]);

const result = await rawtree.query<{ event: string; count: number }>(
  "SELECT event, count() AS count FROM events GROUP BY event"
);

const tables = await rawtree.tables.list();
const schema = await rawtree.tables.describe("events");
```

## API

```ts
new RawTree({
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
});
```

The SDK sends the API key as `Authorization: Bearer <apiKey>`.

### query

```ts
rawtree.query<Row = unknown>(
  sql: string | { sql: string },
  options?: RequestOptions,
): Promise<QueryResponse<Row>>;
```

### insert

```ts
rawtree.insert<Row extends JsonObject = JsonObject>(
  table: string,
  rows: Row | Row[],
  options?: RequestOptions,
): Promise<InsertResponse>;
```

### tables

```ts
rawtree.tables.list(options?: RequestOptions): Promise<TablesResponse>;
rawtree.tables.describe(table: string, options?: RequestOptions): Promise<DescribeTableResponse>;
```
