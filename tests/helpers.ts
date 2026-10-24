import { spawn, spawnSync } from 'node:child_process';
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

// Like runNode, but returns at once so several processes can run side by side.
export function runNodeAsync(script: string, args: string[]): Promise<Exec> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-warnings', script, ...args]);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

export function runCli(args: string[]): Exec {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
