// MCP tools over the service: specification 2026-07-28, stateless, through the TypeScript SDK
// v2. Each tool is one service call. The schemas describe the input; the service validates it,
// so a bad input is the same domain error here as on every other surface.

import {
  createMcpHandler,
  fromJsonSchema,
  McpServer,
  type CallToolResult,
  type JsonSchemaType,
  type jsonSchemaValidator,
  type McpHttpHandler,
} from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import type { Principal } from '../access/index.ts';
import { CONTENT_TYPES, InternalError, MEMORY_STATES, toProblem } from '../model/index.ts';
import type { MemoryClient, MemoryService, WriteOptions } from '../service/index.ts';

export const MCP_PROTOCOL_VERSION = '2026-07-28';
const SERVER_INFO = { name: 'memorykit', version: '0.1.0' };

// The service is the only validator; the SDK hands the arguments through unchanged.
const PASS_THROUGH: jsonSchemaValidator = {
  getValidator: () => (input) => ({ valid: true, data: input as never, errorMessage: undefined }),
};

const string = { type: 'string' } as const;
const revision = { type: 'integer', minimum: 1 } as const;
const strings = { type: 'array', items: string, minItems: 1 } as const;
const metadata = { type: 'object', description: 'JSON values by key' } as const;
const links = {
  type: 'array',
  items: object({ type: string, target: string }, ['type', 'target']),
} as const;
const provenance = object(
  {
    origin: object({ kind: string, name: string, version: string }, ['kind', 'name']),
    reason: string,
    evidence: { type: 'array', items: object({ ref: string, note: string }, ['ref']) },
  },
  []
);
const contentType = { type: 'string', enum: [...CONTENT_TYPES] } as const;
// Write options ride beside the service input and are taken off before the call.
const writeOptions = {
  operationId: { type: 'string', description: 'Idempotency key for this write' },
  waitForHistoryMs: {
    type: 'integer',
    minimum: 0,
    description: 'How long to wait for history',
  },
} as const;
const record = {
  kind: string,
  content: string,
  contentType,
  metadata,
  links,
  provenance,
} as const;

// The service refuses fields it does not know, so every object closes.
function object(properties: Record<string, unknown>, required: string[]): JsonSchemaType {
  return { type: 'object', properties, required, additionalProperties: false } as JsonSchemaType;
}

type Args = Record<string, unknown>;

// Takes the write options off the arguments, leaving the service input.
function split(args: Args): [Args, WriteOptions] {
  const { operationId, waitForHistoryMs, ...input } = args;
  const opts: WriteOptions = {};
  if (operationId !== undefined) opts.operationId = operationId as string;
  if (waitForHistoryMs !== undefined) opts.waitForHistoryMs = waitForHistoryMs as number;
  return [input, opts];
}

interface ToolSpec {
  description: string;
  inputSchema: JsonSchemaType;
  call(client: MemoryClient, args: Args): Promise<object>;
}

// Inputs are passed through untyped: the service checks every field.
/* eslint-disable @typescript-eslint/no-explicit-any */
const TOOLS: Record<string, ToolSpec> = {
  memory_create: {
    description: 'Create a memory in a namespace.',
    inputSchema: object({ namespace: string, key: string, ...record, ...writeOptions }, [
      'namespace',
      'kind',
      'content',
    ]),
    call: (client, args) => client.create(...(split(args) as [any, WriteOptions])),
  },
  memory_get: {
    description: 'Read the current record of a memory.',
    inputSchema: object({ id: string }, ['id']),
    call: (client, args) => client.get(args.id as string),
  },
  memory_update: {
    description: 'Change a memory; omitted fields keep their value.',
    inputSchema: object({ id: string, expectedRevision: revision, ...record, ...writeOptions }, [
      'id',
      'expectedRevision',
    ]),
    call: (client, args) => client.update(...(split(args) as [any, WriteOptions])),
  },
  memory_archive: transition('archive', 'Archive an active memory.'),
  memory_restore: transition(
    'restore',
    'Restore an archived memory to active, or a tombstoned one to the state it had before; ' +
      'restoring a tombstone needs the tombstone permission.'
  ),
  memory_tombstone: transition(
    'tombstone',
    'Tombstone a memory: it stays readable but takes no updates until it is restored.'
  ),
  memory_supersede: {
    description: 'Replace a memory with a new one that supersedes it.',
    inputSchema: object(
      {
        id: string,
        expectedRevision: revision,
        replacement: object({ namespace: string, key: string, ...record }, ['kind', 'content']),
        ...writeOptions,
      },
      ['id', 'expectedRevision', 'replacement']
    ),
    call: (client, args) => client.supersede(...(split(args) as [any, WriteOptions])),
  },
  memory_search: {
    description: 'Find memories; every filter given must match.',
    inputSchema: object(
      {
        namespaces: strings,
        text: string,
        kinds: strings,
        states: { type: 'array', items: { type: 'string', enum: [...MEMORY_STATES] }, minItems: 1 },
        metadata: { type: 'object', description: 'Top-level equality on scalar values' },
        limit: { type: 'integer', minimum: 1 },
        cursor: string,
      },
      []
    ),
    call: (client, args) => client.search(args as any),
  },
  memory_retrieve: {
    description:
      'Find memories as compact items: an excerpt, evidence refs and replacements, without ' +
      'whole records. Fetch a full record with memory_get.',
    inputSchema: object(
      {
        namespaces: strings,
        text: string,
        kinds: strings,
        states: { type: 'array', items: { type: 'string', enum: [...MEMORY_STATES] }, minItems: 1 },
        metadata: { type: 'object', description: 'Top-level equality on scalar values' },
        limit: { type: 'integer', minimum: 1 },
        excerptChars: { type: 'integer', minimum: 1 },
        cursor: string,
      },
      ['text']
    ),
    call: (client, args) => client.retrieve(args as any),
  },
  memory_history: {
    description: 'List the revisions history holds for a memory.',
    inputSchema: object({ id: string }, ['id']),
    // structuredContent is an object, so the list is wrapped.
    call: async (client, args) => ({ revisions: await client.history(args.id as string) }),
  },
  memory_revision: {
    description: 'Read one revision of a memory from history.',
    inputSchema: object({ id: string, revision: revision }, ['id', 'revision']),
    call: (client, args) => client.revision(args.id as string, args.revision as number),
  },
  memory_operation: {
    description: 'Read the outcome of a write by its operation id.',
    inputSchema: object({ operationId: string }, ['operationId']),
    call: (client, args) => client.operation(args.operationId as string),
  },
};

function transition(name: 'archive' | 'restore' | 'tombstone', description: string): ToolSpec {
  return {
    description,
    inputSchema: object({ id: string, expectedRevision: revision, provenance, ...writeOptions }, [
      'id',
      'expectedRevision',
    ]),
    call: (client, args) => client[name](...(split(args) as [any, WriteOptions])),
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export const MCP_TOOLS: readonly string[] = Object.keys(TOOLS);

function result(value: object): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
  };
}

function failure(error: unknown): CallToolResult {
  const { title, code, retryable, details } = toProblem(error);
  return {
    isError: true,
    content: [{ type: 'text', text: title }],
    structuredContent: { code, retryable, details },
  };
}

// One server instance for one serving unit, acting for one caller.
export function createMcpServer(client: MemoryClient): McpServer {
  const server = new McpServer(SERVER_INFO, { capabilities: { tools: {} } });
  for (const [name, spec] of Object.entries(TOOLS)) {
    server.registerTool(
      name,
      {
        description: spec.description,
        inputSchema: fromJsonSchema<Args>(spec.inputSchema, PASS_THROUGH),
      },
      async (args: Args) => {
        try {
          return result(await spec.call(client, args ?? {}));
        } catch (error) {
          return failure(error);
        }
      }
    );
  }
  return server;
}

// Streamable HTTP. The caller authenticates first and passes the principal along; requests in
// a revision other than 2026-07-28 are refused with the supported list.
export function mcpHttpHandler(service: MemoryService): McpHttpHandler {
  return createMcpHandler(
    (ctx) => {
      const principal = ctx.authInfo?.extra?.principal as Principal | undefined;
      if (principal === undefined) throw new InternalError('No principal for the MCP request');
      return createMcpServer(service.as(principal));
    },
    { legacy: 'reject', responseMode: 'json' }
  );
}

// stdio over this process, for one embedded caller. The SDK serves 2025-era hosts
// (including Codex) and the modern binding through the same tool factory. `closed` settles when the client closes
// the input or `close` is called.
export function serveMcpStdio(client: MemoryClient): {
  closed: Promise<void>;
  close(): Promise<void>;
} {
  const handle = serveStdio(() => createMcpServer(client), { legacy: 'serve' });
  let settle = (): void => {};
  const closed = new Promise<void>((resolve) => (settle = resolve));
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => (closing ??= handle.close().finally(settle));
  process.stdin.once('end', () => void close());
  return { closed, close };
}
