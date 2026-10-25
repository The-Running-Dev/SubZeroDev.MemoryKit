import { after, describe, it } from 'node:test';
import { cliDriver } from './conformance/cli-driver.ts';
import { httpDriver } from './conformance/http-driver.ts';
import { SCENARIOS } from './conformance/scenarios.ts';
import { sdkDriver } from './conformance/sdk-driver.ts';

// S1.7, S8.5: every scenario passes through every surface.
for (const driver of [sdkDriver, cliDriver, httpDriver]) {
  describe(`conformance: ${driver.name}`, () => {
    after(() => driver.close?.());
    for (const scenario of SCENARIOS) it(scenario.name, () => scenario.run(driver));
  });
}
