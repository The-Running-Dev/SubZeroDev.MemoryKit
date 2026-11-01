// Destructive contract checks run ONLY against fresh, runner-owned stores.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StorageConfig } from '../sdk/index.ts';
import { createScenarios } from './scenarios.ts';
import { createSdkDriver } from './sdk-driver.ts';

export interface ConformanceReport {
  version: 1;
  passed: boolean;
  cases: { name: string; passed: boolean }[];
}

/** Requires Git. Plugins are trusted executable code. A factory must allocate a fresh
 * external store identity for each case; it must never point at production data.
 * Local directories are cleaned up; external database cleanup belongs to the caller.
 * Error details are deliberately excluded: plugin errors can contain credentials. */
export async function runStorageConformance(
  storage: StorageConfig | ((caseId: string) => StorageConfig)
): Promise<ConformanceReport> {
  const root = mkdtempSync(join(tmpdir(), 'memorykit-conformance-'));
  const configs = new Map<string, StorageConfig>();
  let sequence = 0;
  const driver = createSdkDriver((path) => {
    let configured = configs.get(path);
    if (!configured) {
      configured = typeof storage === 'function' ? storage(`${root}:${sequence++}`) : storage;
      configs.set(path, configured);
    }
    return { path, storage: configured };
  });
  const cases: ConformanceReport['cases'] = [];
  try {
    const scenarios = createScenarios(() => mkdtempSync(join(root, 'case-')));
    for (const scenario of scenarios) {
      try {
        await scenario.run(driver);
        cases.push({ name: scenario.name, passed: true });
      } catch {
        cases.push({ name: scenario.name, passed: false });
      }
    }
    return { version: 1, passed: cases.every((c) => c.passed), cases };
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
