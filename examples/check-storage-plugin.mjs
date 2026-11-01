// Run against fresh disposable backend identities only. The module is trusted code.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { runStorageConformance } from 'subzerodev-memorykit/conformance';

const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const report = await runStorageConformance(() => ({
  ...config,
  ...(config.provider === 'plugin'
    ? { options: { ...config.options, storeId: `conformance-${randomUUID()}` } }
    : {}),
}));
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.passed ? 0 : 1;
