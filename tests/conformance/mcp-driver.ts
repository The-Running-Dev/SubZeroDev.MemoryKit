import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { PERMISSIONS } from '../../src/access/index.ts';
import { MCP_PROTOCOL_VERSION } from '../../src/mcp/index.ts';
import { fromProblem, toProblem } from '../../src/model/index.ts';
import { openTokenStore } from '../../src/sdk/index.ts';
import { serve } from '../../src/server/index.ts';
import { CLI } from '../helpers.ts';
import type { Driver, Result } from './driver.ts';
import { sdkDriver } from './sdk-driver.ts';

interface Running {
  client: Client;
  close(): Promise<void>;
}

function pinned(): Client {
  return new Client(
    { name: 'memorykit-conformance', version: '0.0.0' },
    { versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } } }
  );
}

// `memorykit mcp` as a child process.
async function startStdio(store: string): Promise<Running> {
  const client = pinned();
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: [CLI, 'mcp', '--store', store] })
  );
  return { client, close: () => client.close() };
}

// The loopback service with a local token for every permission, reached at /mcp.
async function startHttp(store: string): Promise<Running> {
  const tokens = await openTokenStore({ path: store });
  let secret: string;
  try {
    ({ secret } = await tokens.issue('conformance', [
      { pattern: '*', permissions: [...PERMISSIONS] },
    ]));
  } finally {
    await tokens.close();
  }
  const server = await serve({
    store: { path: store },
    listen: { host: '127.0.0.1', port: 0 },
    auth: { profile: 'local' },
  });
  const client = pinned();
  await client.connect(
    new StreamableHTTPClientTransport(new URL('/mcp', server.url), {
      requestInit: { headers: { authorization: `Bearer ${secret}` } },
    })
  );
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

export const mcpStdioDriver = driverOver('mcp-stdio', startStdio);
export const mcpHttpDriver = driverOver('mcp-http', startHttp);

const opts = (operationId?: string) => (operationId ? { operationId } : {});

// One MCP connection per store. MCP has no init, status or namespace tools, so those go
// through the SDK.
function driverOver(name: string, start: (store: string) => Promise<Running>): Driver {
  const running = new Map<string, Promise<Running>>();
  async function call(
    store: string,
    tool: string,
    args: Record<string, unknown>
  ): Promise<Result<Record<string, unknown>>> {
    let entry = running.get(store);
    if (entry === undefined) {
      entry = start(store);
      running.set(store, entry);
    }
    try {
      const result = await (await entry).client.callTool({ name: tool, arguments: args });
      const structured = (result.structuredContent ?? {}) as Record<string, unknown>;
      if (result.isError !== true) return { ok: true, value: structured };
      const [text] = result.content as { text?: string }[];
      return { ok: false, problem: toProblem(fromProblem({ ...structured, title: text?.text })) };
    } catch (error) {
      return { ok: false, problem: toProblem(error) };
    }
  }
  return {
    name,
    init: (store) => sdkDriver.init(store),
    create: (store, input, operationId) =>
      call(store, 'memory_create', { ...input, ...opts(operationId) }),
    update: (store, input, operationId) =>
      call(store, 'memory_update', { ...input, ...opts(operationId) }),
    transition: (store, operation, input, operationId) =>
      call(store, `memory_${operation}`, { ...input, ...opts(operationId) }),
    supersede: (store, input, operationId) =>
      call(store, 'memory_supersede', { ...input, ...opts(operationId) }),
    get: (store, id) => call(store, 'memory_get', { id }),
    search: (store, query) => call(store, 'memory_search', query),
    history: async (store, id) => {
      const result = await call(store, 'memory_history', { id });
      return result.ok ? { ok: true, value: result.value.revisions } : result;
    },
    operation: (store, operationId) => call(store, 'memory_operation', { operationId }),
    status: (store) => sdkDriver.status(store),
    getNamespace: (store, ns) => sdkDriver.getNamespace(store, ns),
    setNamespacePolicy: (store, ns, policy) => sdkDriver.setNamespacePolicy(store, ns, policy),
    close: async () => {
      const entries = [...running.values()];
      running.clear();
      await Promise.allSettled(entries.map(async (entry) => (await entry).close()));
    },
  };
}
