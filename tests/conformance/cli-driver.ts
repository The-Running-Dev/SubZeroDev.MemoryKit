import type { Problem } from '../../src/model/index.ts';
import { runCli, type Exec } from '../helpers.ts';
import type { Driver, Result } from './driver.ts';

function parse<T>(exec: Exec, value: (stdout: string) => T): Result<T> {
  if (exec.status === 0 || exec.status === 3) return { ok: true, value: value(exec.stdout) };
  if (exec.status === 1) return { ok: false, problem: JSON.parse(exec.stderr) as Problem };
  throw new Error(`CLI exited ${exec.status}: ${exec.stderr}`);
}

function createArgs(store: string, input: Record<string, unknown>): string[] {
  const args = ['create', '--store', store, '--json'];
  const flags: Record<string, string> = {
    namespace: 'namespace',
    key: 'key',
    kind: 'kind',
    content: 'content',
    contentType: 'content-type',
  };
  for (const [field, flag] of Object.entries(flags)) {
    if (input[field] !== undefined) args.push(`--${flag}`, String(input[field]));
  }
  if (input.metadata !== undefined) args.push('--metadata', JSON.stringify(input.metadata));
  for (const link of (input.links as { type: string; target: string }[] | undefined) ?? []) {
    args.push('--link', `${link.type}:${link.target}`);
  }
  return args;
}

export const cliDriver: Driver = {
  name: 'cli',
  init: async (store) => parse(runCli(['init', store, '--json']), () => null),
  create: async (store, input) =>
    parse(runCli(createArgs(store, input)), (out) => JSON.parse(out) as Record<string, unknown>),
  get: async (store, id) =>
    parse(
      runCli(['get', id, '--store', store, '--json']),
      (out) => JSON.parse(out) as Record<string, unknown>
    ),
};
