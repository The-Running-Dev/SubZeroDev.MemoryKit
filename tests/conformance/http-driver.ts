import { PERMISSIONS } from '../../src/access/index.ts';
import { toProblem } from '../../src/model/index.ts';
import { connect, initStore, openTokenStore } from '../../src/sdk/index.ts';
import { serve } from '../../src/server/index.ts';
import type { HistoryPolicy } from '../../src/contracts/index.ts';
import type { SearchQuery } from '../../src/model/index.ts';
import type {
  CreateInput,
  MemoryClient,
  SupersedeInput,
  TransitionInput,
  UpdateInput,
} from '../../src/service/index.ts';
import type { Driver, Result } from './driver.ts';

async function capture<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, problem: toProblem(error) };
  }
}

function plain(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

interface Running {
  client: MemoryClient;
  close(): Promise<void>;
}

// One loopback service per store, started on first use, with a token for every permission.
const running = new Map<string, Promise<Running>>();

async function start(store: string): Promise<Running> {
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
  return { client: connect(server.url, { token: secret }), close: server.close };
}

async function client(store: string): Promise<MemoryClient> {
  let entry = running.get(store);
  if (entry === undefined) {
    entry = start(store);
    running.set(store, entry);
  }
  return (await entry).client;
}

const opts = (operationId?: string) => (operationId ? { operationId } : {});

export const httpDriver: Driver = {
  name: 'http',
  init: (store) => capture(async () => (await initStore({ path: store }), null)),
  create: (store, input, operationId) =>
    capture(async () =>
      plain(await (await client(store)).create(input as unknown as CreateInput, opts(operationId)))
    ),
  update: (store, input, operationId) =>
    capture(async () =>
      plain(await (await client(store)).update(input as unknown as UpdateInput, opts(operationId)))
    ),
  transition: (store, operation, input, operationId) =>
    capture(async () =>
      plain(
        await (
          await client(store)
        )[operation](input as unknown as TransitionInput, opts(operationId))
      )
    ),
  supersede: (store, input, operationId) =>
    capture(async () =>
      plain(
        await (await client(store)).supersede(input as unknown as SupersedeInput, opts(operationId))
      )
    ),
  get: (store, id) => capture(async () => plain(await (await client(store)).get(id))),
  search: (store, query) =>
    capture(async () => plain(await (await client(store)).search(query as unknown as SearchQuery))),
  history: (store, id) => capture(async () => plain(await (await client(store)).history(id))),
  operation: (store, operationId) =>
    capture(async () => plain(await (await client(store)).operation(operationId))),
  status: (store) => capture(async () => plain(await (await client(store)).status())),
  getNamespace: (store, ns) =>
    capture(async () => plain(await (await client(store)).getNamespace(ns))),
  setNamespacePolicy: (store, ns, policy) =>
    capture(async () =>
      plain(await (await client(store)).setNamespacePolicy(ns, policy as HistoryPolicy))
    ),
  close: async () => {
    const entries = [...running.values()];
    running.clear();
    await Promise.allSettled(entries.map(async (entry) => (await entry).close()));
  },
};
