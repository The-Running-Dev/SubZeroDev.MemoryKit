import { describe, it } from 'node:test';
import { cliDriver } from './conformance/cli-driver.ts';
import { SCENARIOS } from './conformance/scenarios.ts';
import { sdkDriver } from './conformance/sdk-driver.ts';

// S1.7: every scenario passes through every surface.
for (const driver of [sdkDriver, cliDriver]) {
  describe(`conformance: ${driver.name}`, () => {
    for (const scenario of SCENARIOS) it(scenario.name, () => scenario.run(driver));
  });
}
