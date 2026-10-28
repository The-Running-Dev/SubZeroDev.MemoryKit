import type { Problem } from '../../src/model/index.ts';
import { serve } from '../../src/server/index.ts';
import { CLI, runCli, runNodeAsync, type Exec } from '../helpers.ts';
import type { Driver, Result } from './driver.ts';
import { localToken } from './http-driver.ts';

function parse<T>(exec: Exec, value: (stdout: string) => T): Result<T> {
  if (exec.status === 0 || exec.status === 3) return { ok: true, value: value(exec.stdout) };
  if (exec.status === 1) return { ok: false, problem: JSON.parse(exec.stderr) as Problem };
  throw new Error(`CLI exited ${exec.status}: ${exec.stderr}`);
}

function writeArgs(
  head: string[],
  store: string,
  input: Record<string, unknown>,
  operationId: string | undefined
): string[] {
  const args = [...head, '--store', store, '--json'];
  if (operationId !== undefined) args.push('--operation-id', operationId);
  if (input.expectedRevision !== undefined) {
    args.push('--expected-revision', String(input.expectedRevision));
  }
  const flags: Record<string, string> = {
    namespace: 'namespace',
    key: 'key',
    kind: 'kind',
    content: 'content',
    contentType: 'content-type',
  };
  for (const [field, flag] of Object.entries(flags)) {
    if (input[field] !== undefined) args.push(`--${flag}=${String(input[field])}`);
  }
  if (input.metadata !== undefined) args.push('--metadata', JSON.stringify(input.metadata));
  if (input.provenance !== undefined) {
    args.push('--provenance', JSON.stringify(input.provenance));
  }
  for (const link of (input.links as { type: string; target: string }[] | undefined) ?? []) {
    args.push('--link', `${link.type}:${link.target}`);
  }
  return args;
}

function searchArgs(
  query: Record<string, unknown>,
  head: string[] = ['search'],
  target: string[] = []
): string[] {
  const args = [...head, ...target, '--json'];
  if (query.text !== undefined) args.push(`--text=${String(query.text)}`);
  const lists: Record<string, string> = { namespaces: 'namespace', kinds: 'kind', states: 'state' };
  for (const [field, flag] of Object.entries(lists)) {
    for (const item of (query[field] as unknown[] | undefined) ?? []) {
      args.push(`--${flag}=${String(item)}`);
    }
  }
  if (query.metadata !== undefined) args.push('--metadata', JSON.stringify(query.metadata));
  if (query.limit !== undefined) args.push('--limit', String(query.limit));
  if (query.cursor !== undefined) args.push(`--cursor=${String(query.cursor)}`);
  if (query.excerptChars !== undefined) args.push('--excerpt-chars', String(query.excerptChars));
  return args;
}

const TOKEN_VARIABLE = 'MEMORYKIT_CONFORMANCE_TOKEN';

function json(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout) as Record<string, unknown>;
}

export const cliDriver: Driver = {
  name: 'cli',
  init: async (store) => parse(runCli(['init', store, '--json']), () => null),
  create: async (store, input, operationId) =>
    parse(
      runCli(writeArgs(['create'], store, input, operationId)),
      (out) => JSON.parse(out) as Record<string, unknown>
    ),
  update: async (store, { id, ...input }, operationId) =>
    parse(
      runCli(writeArgs(['update', String(id)], store, input, operationId)),
      (out) => JSON.parse(out) as Record<string, unknown>
    ),
  transition: async (store, operation, { id, ...input }, operationId) =>
    parse(runCli(writeArgs([operation, String(id)], store, input, operationId)), json),
  supersede: async (store, { id, expectedRevision, replacement }, operationId) =>
    parse(
      runCli(
        writeArgs(
          ['supersede', String(id)],
          store,
          { expectedRevision, ...(replacement as Record<string, unknown>) },
          operationId
        )
      ),
      json
    ),
  purge: async (store, { id, ...input }, operationId) =>
    parse(runCli(writeArgs(['purge', String(id)], store, input, operationId)), json),
  get: async (store, id) => parse(runCli(['get', id, '--store', store, '--json']), json),
  search: async (store, query) =>
    parse(runCli(searchArgs(query, ['search'], ['--store', store])), json),
  retrieve: async (store, query) =>
    parse(runCli(searchArgs(query, ['retrieve'], ['--store', store])), json),
  // The CLI reaches a restricted caller only through --url, so this serves the store with a
  // reader's token. The child runs asynchronously, since this process serves its requests.
  retrieveAs: async (store, grants, query) => {
    const secret = await localToken(store, 'reader', grants);
    const server = await serve({
      store: { path: store },
      listen: { host: '127.0.0.1', port: 0 },
      auth: { profile: 'local' },
    });
    try {
      const target = ['--url', server.url, '--token-env', TOKEN_VARIABLE];
      const env = { ...process.env, [TOKEN_VARIABLE]: secret };
      return parse(await runNodeAsync(CLI, searchArgs(query, ['retrieve'], target), env), json);
    } finally {
      await server.close();
    }
  },
  history: async (store, id) => parse(runCli(['history', id, '--store', store, '--json']), json),
  operation: async (store, operationId) =>
    parse(runCli(['operation', operationId, '--store', store, '--json']), json),
  status: async (store) => parse(runCli(['status', '--store', store, '--json']), json),
  getNamespace: async (store, ns) =>
    parse(runCli(['namespace', 'get', ns, '--store', store, '--json']), json),
  setNamespacePolicy: async (store, ns, policy) =>
    parse(
      runCli(['namespace', 'set', ns, '--history-policy', policy, '--store', store, '--json']),
      json
    ),
};
