import { resolve } from 'node:path';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import type {
  HistoryPolicy,
  HistoryQueue,
  RevisionSnapshot,
  RevisionSummary,
  StoreStatus,
} from '../contracts/index.ts';
import {
  ValidationFailedError,
  toProblem,
  type ContentType,
  type Link,
  type LinkType,
} from '../model/index.ts';
import { initStore, openStore } from '../sdk/index.ts';
import type {
  CreateInput,
  MemoryClient,
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
}

export const EXIT_OK = 0;
export const EXIT_DOMAIN_ERROR = 1;
export const EXIT_USAGE = 2;
export const EXIT_HISTORY_PENDING = 3;

const USAGE = `Usage: memorykit <command> [options]

Commands:
  init <dir>                       Create a store in <dir>
  create --store <dir> --namespace <ns> --kind <kind> --content <text>
         [--content-type <type>] [--key <key>] [--metadata <json>]
         [--link <type>:<id>]... [--operation-id <id>]
  update <id> --store <dir> --expected-revision <n>
         [--kind <kind>] [--content <text>] [--content-type <type>]
         [--metadata <json>] [--link <type>:<id>]... [--operation-id <id>]
  get <id> --store <dir>
  history <id> --store <dir>        List the revisions history holds
  revision <id> <n> --store <dir>   Show one revision from history
  operation <operation-id> --store <dir>
  status --store <dir>
  namespace get <ns> --store <dir>
  namespace set <ns> --history-policy <full|metadata|none> --store <dir>
  history-sync --store <dir> [--retry-blocked] [--budget-ms <n>]

Exit codes: 0 success, 3 success with history pending, 1 domain error, 2 usage error.

Options:
  --json   Print the result as JSON
`;

const OPTIONS = {
  store: { type: 'string' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  namespace: { type: 'string' },
  key: { type: 'string' },
  kind: { type: 'string' },
  content: { type: 'string' },
  'content-type': { type: 'string' },
  metadata: { type: 'string' },
  link: { type: 'string', multiple: true },
  'operation-id': { type: 'string' },
  'expected-revision': { type: 'string' },
  'history-policy': { type: 'string' },
  'retry-blocked': { type: 'boolean' },
  'budget-ms': { type: 'string' },
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
  const value = values[name];
  if (value === undefined) throw new UsageError(`--${name} is required`);
  return value;
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

function formatOutcome(outcome: WriteOutcome): string {
  const { memory } = outcome;
  return `${memory.id} revision ${memory.revision} ${memory.state} (history: ${outcome.history})\n`;
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

async function withStore<T>(
  values: Values,
  deps: CliDeps,
  fn: (client: MemoryClient) => Promise<T>
): Promise<T> {
  const client = await deps.openStore({ path: resolve(required(values, 'store')) });
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
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
          kind: required(values, 'kind'),
          content: required(values, 'content'),
        };
        if (values.key !== undefined) input.key = values.key;
        if (values['content-type'] !== undefined)
          input.contentType = values['content-type'] as ContentType;
        const metadata = parseMetadata(values.metadata);
        if (metadata !== undefined) input.metadata = metadata;
        const links = parseLinks(values.link);
        if (links !== undefined) input.links = links;
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
        if (values.kind !== undefined) input.kind = values.kind;
        if (values.content !== undefined) input.content = values.content;
        if (values['content-type'] !== undefined)
          input.contentType = values['content-type'] as ContentType;
        const metadata = parseMetadata(values.metadata);
        if (metadata !== undefined) input.metadata = metadata;
        const links = parseLinks(values.link);
        if (links !== undefined) input.links = links;
        const outcome = await withStore(values, deps, (client) =>
          client.update(input, writeOptions(values))
        );
        print(outcome, formatOutcome(outcome));
        return historyBehind(outcome) ? EXIT_HISTORY_PENDING : EXIT_OK;
      }
      case 'get': {
        const [id] = only(rest, 1, 'get <id>');
        const record = await withStore(values, deps, (client) => client.get(id!));
        print(record, formatRecord(record));
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
