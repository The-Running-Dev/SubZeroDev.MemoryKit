import { resolve } from 'node:path';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { validatePrincipal, type Grant } from '../access/index.ts';
import type {
  HistoryPolicy,
  HistoryQueue,
  PurgeReport,
  RevisionSnapshot,
  RevisionSummary,
  StoreStatus,
  TokenInfo,
  TokenStore,
} from '../contracts/index.ts';
import {
  ValidationFailedError,
  toProblem,
  type ContentType,
  type Link,
  type LinkType,
  type MemoryState,
  type Permission,
  type Provenance,
  type SearchQuery,
  type SearchResult,
} from '../model/index.ts';
import { connect, initStore, openStore, openTokenStore, type StoreConfig } from '../sdk/index.ts';
import { serveMcpStdio } from '../mcp/index.ts';
import { serve, type ServeOptions } from '../server/index.ts';
import type {
  CreateInput,
  MemoryClient,
  SupersedeInput,
  TransitionInput,
  UpdateInput,
  WriteOptions,
  WriteOutcome,
} from '../service/index.ts';
import type { MemoryRecord } from '../model/index.ts';

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

// What the CLI opens stores with; tests replace it to run with a chosen history provider.
export interface CliDeps {
  openStore: typeof openStore;
  connect?: typeof connect;
  serve?: typeof serve;
  openTokenStore?: typeof openTokenStore;
  untilShutdown?: () => Promise<void>;
  env?: Record<string, string | undefined>;
}

export const DEFAULT_LISTEN = '127.0.0.1:7600';

export const EXIT_OK = 0;
export const EXIT_DOMAIN_ERROR = 1;
export const EXIT_USAGE = 2;
export const EXIT_HISTORY_PENDING = 3;

const USAGE = `Usage: memorykit <command> [options]

Every command except init, serve, mcp and token takes either --store <dir> or
--url <url> [--token-env <VAR>], where <VAR> names the variable holding the token.

Commands:
  init <dir>                       Create a store in <dir>
  create --store <dir> --namespace <ns> --kind <kind> --content <text>
         [--content-type <type>] [--key <key>] [--metadata <json>]
         [--link <type>:<id>]... [--provenance <json>] [--operation-id <id>]
  update <id> --store <dir> --expected-revision <n>
         [--kind <kind>] [--content <text>] [--content-type <type>]
         [--metadata <json>] [--link <type>:<id>]... [--provenance <json>]
         [--operation-id <id>]
  archive|restore|tombstone <id> --store <dir> --expected-revision <n>
         [--provenance <json>] [--operation-id <id>]
  supersede <id> --store <dir> --expected-revision <n> --kind <kind> --content <text>
         [--namespace <ns>] [--content-type <type>] [--key <key>] [--metadata <json>]
         [--link <type>:<id>]... [--provenance <json>] [--operation-id <id>]
                                   Replace <id> with a new memory that supersedes it
  purge <id> --store <dir> --expected-revision <n> [--operation-id <id>]
                                   Remove a memory and report each place it was held
  get <id> --store <dir>
  search --store <dir> [--text <words>] [--namespace <pattern>]... [--kind <kind>]...
         [--state <state>]... [--metadata <json>] [--limit <n>] [--cursor <cursor>]
                                   Find memories; every filter given must match
  history <id> --store <dir>        List the revisions history holds
  revision <id> <n> --store <dir>   Show one revision from history
  operation <operation-id> --store <dir>
  status --store <dir>
  namespace get <ns> --store <dir>
  namespace set <ns> --history-policy <full|metadata|none> --store <dir>
  history-sync --store <dir> [--retry-blocked] [--budget-ms <n>]
  serve --store <dir> [--listen <host>:<port>] [--allowed-origin <origin>]...
        [--tls-cert <file> --tls-key <file>]
        [--oidc-issuer <url> --oidc-audience <aud> --oidc-ceiling <permissions>:<pattern>...]
                                   Serve the store over HTTP (default ${DEFAULT_LISTEN});
                                   the --oidc-* flags select remote tokens and need TLS
  mcp --store <dir>                 Serve the store as an MCP server over stdio
  token create --store <dir> --principal <id> --grant <permissions>:<pattern>...
                                   Issue a token; the secret is printed once
  token list --store <dir>
  token revoke <token-id> --store <dir>

--provenance takes {"origin": {"kind", "name", "version"}, "reason", "evidence": [{"ref",
"note"}]}, every field optional.

Exit codes: 0 success, 3 success with history pending, 1 domain error, 2 usage error.

Options:
  --json   Print the result as JSON
`;

const OPTIONS = {
  store: { type: 'string' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  namespace: { type: 'string', multiple: true },
  key: { type: 'string' },
  kind: { type: 'string', multiple: true },
  content: { type: 'string' },
  'content-type': { type: 'string' },
  metadata: { type: 'string' },
  link: { type: 'string', multiple: true },
  provenance: { type: 'string' },
  'operation-id': { type: 'string' },
  'expected-revision': { type: 'string' },
  'history-policy': { type: 'string' },
  'retry-blocked': { type: 'boolean' },
  'budget-ms': { type: 'string' },
  text: { type: 'string' },
  state: { type: 'string', multiple: true },
  limit: { type: 'string' },
  cursor: { type: 'string' },
  url: { type: 'string' },
  'token-env': { type: 'string' },
  listen: { type: 'string' },
  'allowed-origin': { type: 'string', multiple: true },
  'tls-cert': { type: 'string' },
  'tls-key': { type: 'string' },
  'oidc-issuer': { type: 'string' },
  'oidc-audience': { type: 'string' },
  'oidc-ceiling': { type: 'string', multiple: true },
  principal: { type: 'string' },
  grant: { type: 'string', multiple: true },
} satisfies ParseArgsConfig['options'];

type Values = ReturnType<typeof parse>['values'];

class UsageError extends Error {}

function parse(argv: string[]) {
  return parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
}

function required(
  values: Values,
  name: 'store' | 'namespace' | 'kind' | 'content' | 'expected-revision' | 'history-policy'
): string {
  const value = name === 'namespace' || name === 'kind' ? one(values, name) : values[name];
  if (value === undefined) throw new UsageError(`--${name} is required`);
  return value;
}

// Search repeats --namespace and --kind; every other command takes one of each.
function one(values: Values, name: 'namespace' | 'kind'): string | undefined {
  const items = values[name];
  if (items === undefined) return undefined;
  if (items.length > 1) throw new UsageError(`--${name} may be given once`);
  return items[0];
}

function only(positionals: string[], count: number, what: string): string[] {
  if (positionals.length !== count) throw new UsageError(`Expected ${what}`);
  return positionals;
}

function parseMetadata(text: string | undefined): CreateInput['metadata'] {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as CreateInput['metadata'];
  } catch {
    throw new ValidationFailedError('Invalid metadata: invalid_json', {
      field: 'metadata',
      reason: 'invalid_json',
    });
  }
}

// Shaped like the service's provenance; the service checks every field.
function parseProvenance(text: string | undefined): Provenance | undefined {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as Provenance;
  } catch {
    throw new ValidationFailedError('Invalid provenance: invalid_json', {
      field: 'provenance',
      reason: 'invalid_json',
    });
  }
}

function parseLinks(items: string[] | undefined): Link[] | undefined {
  if (items === undefined) return undefined;
  return items.map((item) => {
    const at = item.lastIndexOf(':');
    if (at <= 0) throw new UsageError(`--link must be <type>:<id>, got "${item}"`);
    return { type: item.slice(0, at) as LinkType, target: item.slice(at + 1) };
  });
}

// Passed through as given: the service rejects anything that is not a positive integer.
function parseRevision(text: string): number {
  return /^\d+$/.test(text) ? Number(text) : Number.NaN;
}

// Likewise, the service rejects anything that is not a non-negative integer.
function parseDuration(text: string): number {
  return /^\d+$/.test(text) ? Number(text) : Number.NaN;
}

// And a limit that is not a positive integer.
function parseLimit(text: string): number {
  return /^\d+$/.test(text) ? Number(text) : Number.NaN;
}

function searchQuery(values: Values): SearchQuery {
  const query: SearchQuery = {};
  if (values.namespace !== undefined) query.namespaces = values.namespace;
  if (values.text !== undefined) query.text = values.text;
  if (values.kind !== undefined) query.kinds = values.kind;
  if (values.state !== undefined) query.states = values.state as MemoryState[];
  const metadata = parseMetadata(values.metadata);
  if (metadata !== undefined) query.metadata = metadata as SearchQuery['metadata'];
  if (values.limit !== undefined) query.limit = parseLimit(values.limit);
  if (values.cursor !== undefined) query.cursor = values.cursor;
  return query;
}

// The fields of a new memory, for create and for a supersede's replacement.
function newMemory(values: Values): Omit<CreateInput, 'namespace'> {
  const input: Omit<CreateInput, 'namespace'> = {
    kind: required(values, 'kind'),
    content: required(values, 'content'),
  };
  if (values.key !== undefined) input.key = values.key;
  if (values['content-type'] !== undefined) {
    input.contentType = values['content-type'] as ContentType;
  }
  const metadata = parseMetadata(values.metadata);
  if (metadata !== undefined) input.metadata = metadata;
  const links = parseLinks(values.link);
  if (links !== undefined) input.links = links;
  const provenance = parseProvenance(values.provenance);
  if (provenance !== undefined) input.provenance = provenance;
  return input;
}

const RECORD_FLAGS = ['namespace', 'key', 'kind', 'content', 'content-type', 'metadata', 'link'];

function writeOptions(values: Values): WriteOptions {
  return values['operation-id'] === undefined ? {} : { operationId: values['operation-id'] };
}

function formatRecord(record: MemoryRecord): string {
  const lines = [
    `id:        ${record.id}`,
    `namespace: ${record.namespace}`,
    ...(record.key === null ? [] : [`key:       ${record.key}`]),
    `kind:      ${record.kind}`,
    `state:     ${record.state}`,
    `revision:  ${record.revision}`,
    `updated:   ${record.updatedAt}`,
    '',
    record.content,
  ];
  return lines.join('\n') + '\n';
}

const SUMMARY_LENGTH = 60;

function formatSearch(result: SearchResult): string {
  const lines = result.items.map((item) => {
    const first = item.content.split('\n', 1)[0] ?? '';
    const summary =
      first.length > SUMMARY_LENGTH ? `${first.slice(0, SUMMARY_LENGTH - 3)}...` : first;
    return `${item.id}  ${item.namespace}  ${item.kind}  ${item.state}  ${summary}\n`;
  });
  if (lines.length === 0) lines.push('No memories found\n');
  if (result.completeness === 'partial') {
    lines.push(`results may be incomplete (${result.partialReason})\n`);
  }
  if (result.nextCursor !== null) lines.push(`next cursor: ${result.nextCursor}\n`);
  return lines.join('');
}

function formatOutcome(outcome: WriteOutcome): string {
  const line = (memory: MemoryRecord): string =>
    `${memory.id} revision ${memory.revision} ${memory.state}`;
  return (
    `${line(outcome.memory)} (history: ${outcome.history})\n` +
    outcome.related.map((memory) => `${line(memory)}\n`).join('')
  );
}

function formatPurge(report: PurgeReport): string {
  const lines = Object.entries(report.boundaries).map(
    ([name, { result, detail }]) =>
      `${name.padEnd(22)} ${result}${detail === undefined ? '' : ` (${detail})`}
`
  );
  return (
    `${report.memoryId} purged (operation ${report.operationId})
` + lines.join('')
  );
}

function formatHistory(revisions: RevisionSummary[]): string {
  if (revisions.length === 0) return 'No revisions in history\n';
  return revisions
    .map(
      (item) =>
        `${item.revision}  ${item.operation}  ${item.at}  ${item.actor}  ${item.historyRef}\n`
    )
    .join('');
}

function formatSnapshot(snapshot: RevisionSnapshot): string {
  const { record } = snapshot;
  const header = `revision ${snapshot.revision} ${snapshot.operation} by ${snapshot.actor} at ${snapshot.at} (${snapshot.historyRef})\n`;
  if ('content' in record) return header + formatRecord(record);
  return (
    header +
    `content hash:  ${record.contentHash}\n` +
    `metadata keys: ${record.metadataKeys.join(', ') || '(none)'}\n`
  );
}

// A write whose history has not caught up, whether still pending or blocked, exits 3.
function historyBehind(outcome: WriteOutcome): boolean {
  return outcome.history === 'pending' || outcome.history === 'blocked';
}

function formatQueue(queue: HistoryQueue): string {
  const blocked =
    queue.blocked === null
      ? 'none'
      : `seq ${queue.blocked.seq}, operation ${queue.blocked.operationId} (${queue.blocked.error})`;
  return (
    `history pending: ${queue.pending}\nhistory blocked: ${blocked}\n` +
    `history error: ${queue.lastError ?? 'none'}\n`
  );
}

function formatStatus(status: StoreStatus): string {
  const provider = (item: StoreStatus['storage'] | null): string =>
    item === null ? 'none' : `${item.id} ${item.version}`;
  return (
    `storage: ${provider(status.storage)}\n` +
    `history: ${provider(status.history)}\n` +
    formatQueue(status.historyQueue)
  );
}

function storeConfig(values: Values): StoreConfig {
  return { path: resolve(required(values, 'store')) };
}

// A store opened in this process, or a service reached over HTTP.
async function openClient(
  values: Values,
  deps: CliDeps
): Promise<MemoryClient & { close(): Promise<void> }> {
  if (values.url === undefined) {
    if (values['token-env'] !== undefined) throw new UsageError('--token-env needs --url');
    return deps.openStore(storeConfig(values));
  }
  if (values.store !== undefined) throw new UsageError('Give --store or --url, not both');
  const name = values['token-env'];
  let token: string | undefined;
  if (name !== undefined) {
    token = (deps.env ?? process.env)[name];
    if (token === undefined || token === '') {
      // A token pasted in place of the name must not be echoed back.
      const shown = /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !name.startsWith('mk_') ? name : '';
      throw new UsageError(
        shown === ''
          ? '--token-env must name an environment variable that is set'
          : `The environment variable ${shown} is not set`
      );
    }
  }
  const client = (deps.connect ?? connect)(values.url, token === undefined ? {} : { token });
  return Object.assign(client, { close: async () => {} });
}

async function withStore<T>(
  values: Values,
  deps: CliDeps,
  fn: (client: MemoryClient) => Promise<T>
): Promise<T> {
  const client = await openClient(values, deps);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

// Tokens live in the store, so they are managed locally, never over the API.
async function withTokens<T>(
  values: Values,
  deps: CliDeps,
  fn: (tokens: TokenStore) => Promise<T>
): Promise<T> {
  if (values.url !== undefined) throw new UsageError('token commands take --store, not --url');
  const tokens = await (deps.openTokenStore ?? openTokenStore)(storeConfig(values));
  try {
    return await fn(tokens);
  } finally {
    await tokens.close();
  }
}

// <permissions>:<pattern>, where permissions are comma-separated, as in read,write:demo/*.
function parseGrants(items: string[] | undefined, flag = '--grant'): Grant[] {
  if (items === undefined) throw new UsageError(`${flag} is required`);
  return items.map((item) => {
    const at = item.indexOf(':');
    if (at <= 0) throw new UsageError(`${flag} must be <permissions>:<pattern>, got "${item}"`);
    return {
      pattern: item.slice(at + 1),
      permissions: item.slice(0, at).split(',') as Permission[],
    };
  });
}

function serveTls(values: Values): ServeOptions['tls'] {
  const certFile = values['tls-cert'];
  const keyFile = values['tls-key'];
  if (certFile === undefined && keyFile === undefined) return undefined;
  if (certFile === undefined || keyFile === undefined) {
    throw new UsageError('--tls-cert and --tls-key go together');
  }
  return { certFile, keyFile };
}

function serveAuth(values: Values): ServeOptions['auth'] {
  const issuer = values['oidc-issuer'];
  const audience = values['oidc-audience'];
  const ceiling = values['oidc-ceiling'];
  if (issuer === undefined && audience === undefined && ceiling === undefined) {
    return { profile: 'local' };
  }
  if (issuer === undefined || audience === undefined || ceiling === undefined) {
    throw new UsageError('--oidc-issuer, --oidc-audience and --oidc-ceiling go together');
  }
  return {
    profile: 'remote',
    issuer,
    audience,
    ceiling: parseGrants(ceiling, '--oidc-ceiling'),
  };
}

function parseListen(text: string): { host: string; port: number } {
  const at = text.lastIndexOf(':');
  if (at <= 0) throw new UsageError(`--listen must be <host>:<port>, got "${text}"`);
  const host = text.slice(0, at);
  const port = text.slice(at + 1);
  return {
    host: host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host,
    port: /^\d+$/.test(port) ? Number(port) : Number.NaN,
  };
}

function untilSignal(): Promise<void> {
  return new Promise((resolve) => {
    const stop = (): void => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      resolve();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
}

function formatTokens(tokens: TokenInfo[]): string {
  if (tokens.length === 0) return 'No tokens\n';
  return tokens
    .map((token) => {
      const grants = token.grants
        .map((grant) => `${grant.permissions.join(',')}:${grant.pattern}`)
        .join(' ');
      const state = token.revokedAt === null ? 'active' : `revoked ${token.revokedAt}`;
      return `${token.tokenId}  ${token.principalId}  ${grants}  ${token.createdAt}  ${state}\n`;
    })
    .join('');
}

export async function run(
  argv: string[],
  io: CliIo,
  deps: CliDeps = { openStore }
): Promise<number> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    io.stderr(`${(error as Error).message}\n\n${USAGE}`);
    return EXIT_USAGE;
  }
  const { values, positionals } = parsed;
  const [command, ...rest] = positionals;
  if (values.help || command === undefined || command === 'help') {
    (command === undefined && !values.help ? io.stderr : io.stdout)(USAGE);
    return command === undefined && !values.help ? EXIT_USAGE : EXIT_OK;
  }
  const print = (result: unknown, human: string): void =>
    io.stdout(values.json ? JSON.stringify(result, null, 2) + '\n' : human);

  try {
    switch (command) {
      case 'init': {
        if (values.url !== undefined) throw new UsageError('init takes a directory, not --url');
        const dir =
          rest.length === 0 && values.store !== undefined
            ? values.store
            : only(rest, 1, 'init <dir>')[0]!;
        await initStore({ path: resolve(dir) });
        if (!values.json) io.stdout(`Initialized store at ${resolve(dir)}\n`);
        return EXIT_OK;
      }
      case 'create': {
        only(rest, 0, 'no positional arguments for create');
        const input: CreateInput = {
          namespace: required(values, 'namespace'),
          ...newMemory(values),
        };
        const outcome = await withStore(values, deps, (client) =>
          client.create(input, writeOptions(values))
        );
        print(outcome, formatOutcome(outcome));
        return historyBehind(outcome) ? EXIT_HISTORY_PENDING : EXIT_OK;
      }
      case 'update': {
        const [id] = only(rest, 1, 'update <id>');
        if (values.namespace !== undefined || values.key !== undefined) {
          throw new UsageError('update cannot change --namespace or --key');
        }
        const input: UpdateInput = {
          id: id!,
          expectedRevision: parseRevision(required(values, 'expected-revision')),
        };
        const kind = one(values, 'kind');
        if (kind !== undefined) input.kind = kind;
        if (values.content !== undefined) input.content = values.content;
        if (values['content-type'] !== undefined)
          input.contentType = values['content-type'] as ContentType;
        const metadata = parseMetadata(values.metadata);
        if (metadata !== undefined) input.metadata = metadata;
        const links = parseLinks(values.link);
        if (links !== undefined) input.links = links;
        const provenance = parseProvenance(values.provenance);
        if (provenance !== undefined) input.provenance = provenance;
        const outcome = await withStore(values, deps, (client) =>
          client.update(input, writeOptions(values))
        );
        print(outcome, formatOutcome(outcome));
        return historyBehind(outcome) ? EXIT_HISTORY_PENDING : EXIT_OK;
      }
      case 'archive':
      case 'restore':
      case 'tombstone': {
        const [id] = only(rest, 1, `${command} <id>`);
        const flag = RECORD_FLAGS.find((name) => values[name as keyof Values] !== undefined);
        if (flag !== undefined) throw new UsageError(`${command} does not take --${flag}`);
        const input: TransitionInput = {
          id: id!,
          expectedRevision: parseRevision(required(values, 'expected-revision')),
        };
        const provenance = parseProvenance(values.provenance);
        if (provenance !== undefined) input.provenance = provenance;
        const outcome = await withStore(values, deps, (client) =>
          client[command](input, writeOptions(values))
        );
        print(outcome, formatOutcome(outcome));
        return historyBehind(outcome) ? EXIT_HISTORY_PENDING : EXIT_OK;
      }
      case 'supersede': {
        const [id] = only(rest, 1, 'supersede <id>');
        const input: SupersedeInput = {
          id: id!,
          expectedRevision: parseRevision(required(values, 'expected-revision')),
          replacement: newMemory(values),
        };
        const namespace = one(values, 'namespace');
        if (namespace !== undefined) input.replacement.namespace = namespace;
        const outcome = await withStore(values, deps, (client) =>
          client.supersede(input, writeOptions(values))
        );
        print(outcome, formatOutcome(outcome));
        return historyBehind(outcome) ? EXIT_HISTORY_PENDING : EXIT_OK;
      }
      // A history boundary still waiting on the queue is success with history pending.
      case 'purge': {
        const [id] = only(rest, 1, 'purge <id>');
        const flag = RECORD_FLAGS.find((name) => values[name as keyof Values] !== undefined);
        const purgeFlag = flag ?? (values.provenance === undefined ? undefined : 'provenance');
        if (purgeFlag !== undefined) throw new UsageError(`purge does not take --${purgeFlag}`);
        const input = {
          id: id!,
          expectedRevision: parseRevision(required(values, 'expected-revision')),
        };
        const report = await withStore(values, deps, (client) =>
          client.purge(input, writeOptions(values))
        );
        print(report, formatPurge(report));
        const failed = Object.values(report.boundaries).some((item) => item.result === 'failed');
        return failed ? EXIT_HISTORY_PENDING : EXIT_OK;
      }
      case 'get': {
        const [id] = only(rest, 1, 'get <id>');
        const record = await withStore(values, deps, (client) => client.get(id!));
        print(record, formatRecord(record));
        return EXIT_OK;
      }
      case 'search': {
        only(rest, 0, 'no positional arguments for search');
        const flag = [
          'key',
          'content',
          'content-type',
          'link',
          'provenance',
          'operation-id',
          'expected-revision',
          'budget-ms',
        ].find((name) => values[name as keyof Values] !== undefined);
        if (flag !== undefined) throw new UsageError(`search does not take --${flag}`);
        const query = searchQuery(values);
        const result = await withStore(values, deps, (client) => client.search(query));
        print(result, formatSearch(result));
        return EXIT_OK;
      }
      case 'history': {
        const [id] = only(rest, 1, 'history <id>');
        const revisions = await withStore(values, deps, (client) => client.history(id!));
        print(revisions, formatHistory(revisions));
        return EXIT_OK;
      }
      case 'revision': {
        const [id, revision] = only(rest, 2, 'revision <id> <n>');
        const snapshot = await withStore(values, deps, (client) =>
          client.revision(id!, parseRevision(revision!))
        );
        print(snapshot, formatSnapshot(snapshot));
        return EXIT_OK;
      }
      // Reports the status of an earlier write; a pending one is not this command's failure.
      case 'operation': {
        const [operationId] = only(rest, 1, 'operation <operation-id>');
        const status = await withStore(values, deps, (client) => client.operation(operationId!));
        print(
          status,
          `${status.operationId} ${status.memoryId} revision ${status.revision} (history: ${status.history})\n`
        );
        return EXIT_OK;
      }
      case 'status': {
        only(rest, 0, 'no positional arguments for status');
        const status = await withStore(values, deps, (client) => client.status());
        print(status, formatStatus(status));
        return EXIT_OK;
      }
      case 'namespace': {
        const [action, ns] = only(rest, 2, 'namespace get|set <ns>');
        let info;
        if (action === 'get') {
          if (values['history-policy'] !== undefined) {
            throw new UsageError('namespace get does not take --history-policy');
          }
          info = await withStore(values, deps, (client) => client.getNamespace(ns!));
        } else if (action === 'set') {
          const policy = required(values, 'history-policy') as HistoryPolicy;
          info = await withStore(values, deps, (client) => client.setNamespacePolicy(ns!, policy));
        } else {
          throw new UsageError('Expected namespace get|set <ns>');
        }
        print(info, `${info.name} history policy: ${info.historyPolicy}\n`);
        return EXIT_OK;
      }
      case 'history-sync': {
        only(rest, 0, 'no positional arguments for history-sync');
        const opts: { retryBlocked?: boolean; budgetMs?: number } = {};
        if (values['retry-blocked']) opts.retryBlocked = true;
        if (values['budget-ms'] !== undefined) opts.budgetMs = parseDuration(values['budget-ms']);
        const queue = await withStore(values, deps, (client) => client.syncHistory(opts));
        print(queue, formatQueue(queue));
        return queue.pending > 0 || queue.blocked !== null ? EXIT_HISTORY_PENDING : EXIT_OK;
      }
      case 'serve': {
        only(rest, 0, 'no positional arguments for serve');
        if (values.url !== undefined) throw new UsageError('serve takes --store, not --url');
        const tls = serveTls(values);
        const server = await (deps.serve ?? serve)({
          store: storeConfig(values),
          listen: parseListen(values.listen ?? DEFAULT_LISTEN),
          ...(tls === undefined ? {} : { tls }),
          auth: serveAuth(values),
          ...(values['allowed-origin'] === undefined
            ? {}
            : { allowedOrigins: values['allowed-origin'] }),
        });
        try {
          print({ url: server.url }, `Listening on ${server.url}\n`);
          await (deps.untilShutdown ?? untilSignal)();
        } finally {
          await server.close();
        }
        return EXIT_OK;
      }
      case 'mcp': {
        only(rest, 0, 'no positional arguments for mcp');
        if (values.url !== undefined) throw new UsageError('mcp takes --store, not --url');
        // stdout carries only protocol messages from here on.
        const client = await deps.openStore(storeConfig(values));
        try {
          const server = serveMcpStdio(client);
          await Promise.race([server.closed, (deps.untilShutdown ?? untilSignal)()]);
          await server.close();
        } finally {
          await client.close();
        }
        return EXIT_OK;
      }
      case 'token': {
        const [action, ...args] = rest;
        if (action === 'create') {
          only(args, 0, 'token create --principal <id> --grant <permissions>:<pattern>');
          if (values.principal === undefined) throw new UsageError('--principal is required');
          const principal = validatePrincipal({
            id: values.principal,
            profile: 'local',
            grants: parseGrants(values.grant),
          });
          const issued = await withTokens(values, deps, (tokens) =>
            tokens.issue(principal.id, principal.grants)
          );
          print(
            issued,
            `token id: ${issued.tokenId}\nsecret:   ${issued.secret}\n` +
              'The secret is shown only now; keep it somewhere safe.\n'
          );
        } else if (action === 'list') {
          only(args, 0, 'token list');
          const tokens = await withTokens(values, deps, (store) => store.list());
          print(tokens, formatTokens(tokens));
        } else if (action === 'revoke') {
          const [tokenId] = only(args, 1, 'token revoke <token-id>');
          await withTokens(values, deps, (tokens) => tokens.revoke(tokenId!));
          print({ tokenId, revoked: true }, `Revoked ${tokenId}\n`);
        } else {
          throw new UsageError('Expected token create|list|revoke');
        }
        return EXIT_OK;
      }
      default:
        throw new UsageError(`Unknown command "${command}"`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`${error.message}\n\n${USAGE}`);
      return EXIT_USAGE;
    }
    io.stderr(JSON.stringify(toProblem(error)) + '\n');
    return EXIT_DOMAIN_ERROR;
  }
}
