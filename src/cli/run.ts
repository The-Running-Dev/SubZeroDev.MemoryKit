import { resolve } from 'node:path';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import {
  ValidationFailedError,
  toProblem,
  type ContentType,
  type Link,
  type LinkType,
} from '../model/index.ts';
import { initStore, openStore } from '../sdk/index.ts';
import type { CreateInput, MemoryClient, WriteOutcome } from '../service/index.ts';
import type { MemoryRecord } from '../model/index.ts';

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
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
  get <id> --store <dir>

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
} satisfies ParseArgsConfig['options'];

type Values = ReturnType<typeof parse>['values'];

class UsageError extends Error {}

function parse(argv: string[]) {
  return parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
}

function required(values: Values, name: 'store' | 'namespace' | 'kind' | 'content'): string {
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

async function withStore<T>(values: Values, fn: (client: MemoryClient) => Promise<T>): Promise<T> {
  const client = await openStore({ path: resolve(required(values, 'store')) });
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

export async function run(argv: string[], io: CliIo): Promise<number> {
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
        const outcome = await withStore(values, (client) =>
          client.create(
            input,
            values['operation-id'] === undefined ? {} : { operationId: values['operation-id'] }
          )
        );
        print(outcome, formatOutcome(outcome));
        return outcome.history === 'pending' ? EXIT_HISTORY_PENDING : EXIT_OK;
      }
      case 'get': {
        const [id] = only(rest, 1, 'get <id>');
        const record = await withStore(values, (client) => client.get(id!));
        print(record, formatRecord(record));
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
