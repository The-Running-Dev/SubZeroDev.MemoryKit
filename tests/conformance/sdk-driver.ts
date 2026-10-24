import { toProblem } from '../../src/model/index.ts';
import { initStore, openStore } from '../../src/sdk/index.ts';
import type { CreateInput, UpdateInput } from '../../src/service/index.ts';
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
  get: (store, id) => capture(async () => plain(await withClient(store, (c) => c.get(id)))),
};
