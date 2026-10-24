import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const CLI = join(REPO_ROOT, 'src', 'cli', 'main.ts');

const created: string[] = [];
after(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'memorykit-'));
  created.push(dir);
  return dir;
}

export interface Exec {
  status: number | null;
  stdout: string;
  stderr: string;
}

// Runs a TypeScript entry point in a separate Node process.
export function runNode(script: string, args: string[]): Exec {
  const result = spawnSync(process.execPath, ['--no-warnings', script, ...args], {
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

export function runCli(args: string[]): Exec {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
