import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { configuredStorage } from './conformance/storage.ts';
import { after, describe, it } from 'node:test';
import { cliDriver } from './conformance/cli-driver.ts';
import { httpDriver, oidcDriver } from './conformance/http-driver.ts';
import { mcpHttpDriver, mcpStdioDriver } from './conformance/mcp-driver.ts';
import { SCENARIOS } from './conformance/scenarios.ts';
import { sdkDriver } from './conformance/sdk-driver.ts';
import { initStore } from '../src/sdk/index.ts';
import { toProblem } from '../src/model/index.ts';
import type { Driver } from './conformance/driver.ts';

// S1.7, S8.5, S9, S10.3: every scenario passes through every surface.
const drivers = [sdkDriver, cliDriver, httpDriver, oidcDriver, mcpStdioDriver, mcpHttpDriver];
for (const driver of [
  ...(process.env.MEMORYKIT_ONLY_POSTGRES ? [] : drivers),
  ...(process.env.MEMORYKIT_ONLY_POSTGRES
    ? []
    : drivers.map((d): Driver => ({
        ...d,
        name: d.name + ' / markdown',
        storageId: 'storage-markdown',
        async init(store) {
          try {
            await initStore({ path: store, storage: { provider: 'markdown' } });
            return { ok: true, value: null };
          } catch (e) {
            return { ok: false, problem: toProblem(e) };
          }
        },
      }))),
  ...(process.env.MEMORYKIT_TEST_POSTGRES_URL
    ? drivers.map((d): Driver => ({
        ...d,
        name: d.name + ' / postgres',
        storageId: 'storage-postgres',
        async init(store) {
          configuredStorage.set(store, {
            provider: 'plugin',
            module: fileURLToPath(new URL('../src/storage-postgres/index.ts', import.meta.url)),
            options: { connectionStringEnv: 'MEMORYKIT_TEST_POSTGRES_URL', storeId: randomUUID() },
          });
          return sdkDriver.init(store);
        },
      }))
    : []),
]) {
  describe(`conformance: ${driver.name}`, () => {
    after(() => driver.close?.());
    for (const scenario of SCENARIOS) it(scenario.name, () => scenario.run(driver));
  });
}
