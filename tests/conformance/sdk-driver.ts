import { toProblem } from '../../src/model/index.ts';
import { initStore, openStore } from '../../src/sdk/index.ts';
import type { HistoryPolicy } from '../../src/contracts/index.ts';
import type { SearchQuery } from '../../src/model/index.ts';
import type {
  CreateInput,
  PurgeInput,
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

// Round-trips through JSON so both drivers compare plain wire values.
function plain(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

async function withClient<T>(
  store: string,
  fn: (client: Awaited<ReturnType<typeof openStore>>) => Promise<T>
): Promise<T> {
  const client = await openStore({ path: store });
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

export const sdkDriver: Driver = {
  name: 'sdk',
  init: (store) => capture(async () => (await initStore({ path: store }), null)),
  create: (store, input, operationId) =>
    capture(async () =>
      plain(
        await withClient(store, (c) =>
          c.create(input as unknown as CreateInput, operationId ? { operationId } : {})
        )
      )
    ),
  update: (store, input, operationId) =>
    capture(async () =>
      plain(
        await withClient(store, (c) =>
          c.update(input as unknown as UpdateInput, operationId ? { operationId } : {})
        )
      )
    ),
  transition: (store, operation, input, operationId) =>
    capture(async () =>
      plain(
        await withClient(store, (c) =>
          c[operation](input as unknown as TransitionInput, operationId ? { operationId } : {})
        )
      )
    ),
  supersede: (store, input, operationId) =>
    capture(async () =>
      plain(
        await withClient(store, (c) =>
          c.supersede(input as unknown as SupersedeInput, operationId ? { operationId } : {})
        )
      )
    ),
  purge: (store, input, operationId) =>
    capture(async () =>
      plain(
        await withClient(store, (c) =>
          c.purge(input as unknown as PurgeInput, operationId ? { operationId } : {})
        )
      )
    ),
  get: (store, id) => capture(async () => plain(await withClient(store, (c) => c.get(id)))),
  search: (store, query) =>
    capture(async () =>
      plain(await withClient(store, (c) => c.search(query as unknown as SearchQuery)))
    ),
  history: (store, id) => capture(async () => plain(await withClient(store, (c) => c.history(id)))),
  operation: (store, operationId) =>
    capture(async () => plain(await withClient(store, (c) => c.operation(operationId)))),
  status: (store) => capture(async () => plain(await withClient(store, (c) => c.status()))),
  getNamespace: (store, ns) =>
    capture(async () => plain(await withClient(store, (c) => c.getNamespace(ns)))),
  setNamespacePolicy: (store, ns, policy) =>
    capture(async () =>
      plain(await withClient(store, (c) => c.setNamespacePolicy(ns, policy as HistoryPolicy)))
    ),
};
