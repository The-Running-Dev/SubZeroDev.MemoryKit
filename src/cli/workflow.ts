import { closeSync, existsSync, mkdirSync, openSync, readSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  parseHookEvent,
  projectNamespace,
  promptQuery,
  readTranscript,
  type Host,
} from '../hosts/index.ts';
import { sha256Hex, toProblem, ValidationFailedError } from '../model/index.ts';
import {
  CommandDistiller,
  CommandEmbeddings,
  CommandRecallSelector,
  type CommandProviderOptions,
} from '../providers-command/index.ts';
import { connect, initStore, openStore, storeExists, type StorageConfig } from '../sdk/index.ts';
import { STORAGE_OPTIONS, storageOptions, storageArgs } from './storage.ts';
import { validateStorageConfig } from '../sdk/storage.ts';
import {
  accept,
  capture,
  context,
  fields,
  integer,
  planCapture,
  scopes,
  type CaptureInput,
  type ContextInput,
} from '../workflow/index.ts';
import {
  importClaudeMem,
  planClaudeMemImport,
  type ClaudeMemImportOptions,
} from '../workflow/import.ts';
import type { CliDeps, CliIo } from './run.ts';

export const WORKFLOW_COMMANDS = [
  'setup',
  'upgrade',
  'doctor',
  'capture',
  'context',
  'accept',
  'import-claude-mem',
  'hook',
];
const HELP = `MemoryKit portable workflows:
  setup --store <dir> --output <dir> [--namespace <ns>] [--shared-namespace <ns>]...
        [--capture] [--include-candidates] [--startup-context] [--history git|none]
        [--storage sqlite|markdown | --storage-plugin <absolute-module> [--storage-options <json>]]
    Creates a new store if absent and writes a profile plus host configuration fragments.
    Merge fragments into host settings to activate; existing host settings are untouched.
  upgrade --profile <json> --output <new-dir>
    Regenerates the profile and host fragments using this installed CLI.
  doctor --profile <json>
    Opens the configured store and reports provider, history queue and workflow status.
  capture --profile <json> --input <json|->
  context --profile <json> [--text <query>] [--text-output] [--include-candidates]
  accept <id> --profile <json> --expected-revision <n>
  import-claude-mem --profile <json> --input <json|-> --mapping <json>
        --source-id <stable-installation-id> [--project <source-project>]... [--dry-run]
  hook --profile <json> --host claude-code|codex  (host event JSON on stdin)

Instead of --profile, capture/context/accept/import accept --store <dir> or --url <url>
[--token-env <VAR>], with --namespace <ns> and explicit --shared-namespace <ns>.
Without --namespace, derives project/<owner>/<repo> from the current Git origin.
Context defaults to accepted active records. Capture creates candidates only.
--max-bytes <512..65536>, --limit <1..50> bound context. Capture --input is a
{namespace, source:{host,sessionId,eventId,ref}, observations:[{id,role,content}]} object.
`;

interface Profile {
  version: 1;
  store?: string;
  storage?: StorageConfig;
  url?: string;
  tokenEnv?: string;
  namespace?: string;
  sharedNamespaces?: string[];
  history?: 'git' | 'none';
  capture?: boolean;
  context?: boolean;
  startupContext?: boolean;
  includeCandidates?: boolean;
  maxBytes?: number;
  limit?: number;
  distiller?: CommandProviderOptions;
  embedding?: { id: string; command: CommandProviderOptions };
  recall?: {
    id: string;
    command: CommandProviderOptions;
    discovery?: boolean;
    verification?: boolean;
  };
}
function readBounded(fd: number, max: number): string {
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const chunk = Buffer.alloc(65536);
    const bytes = readSync(fd, chunk, 0, chunk.length, null);
    if (bytes === 0) return Buffer.concat(chunks).toString('utf8');
    size += bytes;
    if (size > max) throw new ValidationFailedError('Input exceeds the byte limit');
    chunks.push(chunk.subarray(0, bytes));
  }
}
function jsonFile(path: string, max = 16 * 1024 * 1024): unknown {
  // File imports and host events are bounded before parsing, including stdin.
  if (path === '-') return parseJson(readBounded(0, max));
  const fd = openSync(path, 'r');
  try {
    return parseJson(readBounded(fd, max));
  } finally {
    closeSync(fd);
  }
}
function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch {
    throw new ValidationFailedError('Input must be JSON');
  }
}
function profile(value: unknown): Profile {
  fields(
    value,
    [
      'version',
      'store',
      'storage',
      'url',
      'tokenEnv',
      'namespace',
      'sharedNamespaces',
      'history',
      'capture',
      'context',
      'startupContext',
      'includeCandidates',
      'maxBytes',
      'limit',
      'distiller',
      'embedding',
      'recall',
    ],
    ['version']
  );
  if (
    value.version !== 1 ||
    (value.store !== undefined && value.url !== undefined) ||
    (value.store !== undefined && (typeof value.store !== 'string' || !isAbsolute(value.store))) ||
    (value.url !== undefined && typeof value.url !== 'string') ||
    (value.tokenEnv !== undefined &&
      (typeof value.tokenEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.tokenEnv))) ||
    (value.history !== undefined && !['git', 'none'].includes(value.history as string)) ||
    ['capture', 'context', 'startupContext', 'includeCandidates'].some(
      (key) => value[key] !== undefined && typeof value[key] !== 'boolean'
    )
  ) {
    throw new ValidationFailedError('Invalid workflow profile');
  }
  const p = value as unknown as Profile;
  if (p.storage !== undefined) {
    validateStorageConfig(p.storage);
    if (!p.store) throw new ValidationFailedError('Storage configuration requires a local store');
  }
  scopes({
    namespace: p.namespace ?? 'project/placeholder/repo',
    sharedNamespaces: p.sharedNamespaces,
  });
  integer(p.maxBytes, 'maxBytes', 8192, 512, 65536);
  integer(p.limit, 'limit', 10, 1, 50);
  if (p.distiller !== undefined) validateCommand(p.distiller);
  for (const provider of [p.embedding, p.recall]) {
    if (provider === undefined) continue;
    fields(
      provider,
      ['id', 'command', ...(provider === p.recall ? ['discovery', 'verification'] : [])],
      ['id', 'command']
    );
    if (typeof provider.id !== 'string' || provider.id.trim() === '' || provider.id.length > 256)
      throw new ValidationFailedError('Provider needs an id');
    validateCommand(provider.command);
  }
  if (p.recall?.verification !== undefined && typeof p.recall.verification !== 'boolean')
    throw new ValidationFailedError('Invalid recall verification option');
  if (p.recall?.discovery !== undefined && typeof p.recall.discovery !== 'boolean')
    throw new ValidationFailedError('Invalid recall discovery option');
  return p;
}
function validateCommand(value: unknown): void {
  fields(value, ['command', 'args', 'timeoutMs', 'maxOutputBytes'], ['command']);
  if (
    typeof value.command !== 'string' ||
    value.command === '' ||
    (value.args !== undefined &&
      (!Array.isArray(value.args) || value.args.some((arg) => typeof arg !== 'string')))
  ) {
    throw new ValidationFailedError('Invalid provider command');
  }
  integer(value.timeoutMs, 'timeoutMs', 30000, 1, 120000);
  integer(value.maxOutputBytes, 'maxOutputBytes', 4 * 1024 * 1024, 1, 16 * 1024 * 1024);
}

// Shell-form Codex commands use only generated, quoted paths. Refuse shell metacharacters
// rather than generate a command that changes meaning on a different Windows shell.
function quoted(path: string): string {
  if (/["%!$`\r\n]/u.test(path))
    throw new ValidationFailedError('Setup path contains unsupported shell characters');
  return '"' + path.replaceAll('\\', '/') + '"';
}
async function setup(p: Profile, output: string): Promise<object> {
  const cli = fileURLToPath(
    new URL('./main' + (import.meta.url.endsWith('.ts') ? '.ts' : '.js'), import.meta.url)
  );
  const config = join(output, 'memorykit.profile.json');
  const hook = (host: Host): object => {
    const args = [cli, 'hook', '--profile', config, '--host', host];
    const command =
      host === 'claude-code'
        ? { command: process.execPath, args }
        : { command: 'node ' + args.map(quoted).join(' ') };
    const group = (timeout: number) => ({
      matcher: '',
      hooks: [{ type: 'command', ...command, timeout }],
    });
    return {
      hooks: {
        ...(p.context === false
          ? {}
          : {
              UserPromptSubmit: [
                group(
                  Math.ceil(
                    ((p.recall?.command.timeoutMs ?? 30000) *
                      (1 +
                        Number(p.recall?.discovery === true) +
                        Number(p.recall?.verification === true))) /
                      1000
                  ) + 10
                ),
              ],
            }),
        ...(p.context !== false && p.startupContext === true ? { SessionStart: [group(30)] } : {}),
        ...(p.capture ? { Stop: [group(60)], PreCompact: [group(60)] } : {}),
      },
    };
  };
  const files = {
    'memorykit.profile.json': JSON.stringify(p, null, 2),
    'claude.settings.fragment.json': JSON.stringify(hook('claude-code'), null, 2),
    'codex.hooks.fragment.json': JSON.stringify(hook('codex'), null, 2),
    'mcp.fragment.json': JSON.stringify(
      {
        mcpServers: {
          memorykit: {
            command: process.execPath,
            args: [
              cli,
              'mcp',
              '--store',
              p.store,
              '--history',
              p.history ?? 'git',
              ...storageArgs(p.storage),
            ],
          },
        },
      },
      null,
      2
    ),
    'README.md': `# MemoryKit host setup\n\nProfile: ${config}\n\nMerge the Claude fragment's event groups into ~/.claude/settings.json and the Codex fragment's groups into ~/.codex/hooks.json. Preserve existing groups. In Codex, use /hooks to review and trust the new hooks. Remove these groups to uninstall. The MCP fragment uses the common JSON server format; adapt it to your host's server configuration.\n\nCapture is ${p.capture ? 'enabled in this profile' : 'off'}. Context ${p.includeCandidates ? 'includes visibly attributed, unverified candidates' : 'includes accepted records only'}. UserPromptSubmit queries with the submitted prompt and emits additionalContext only for matching memories. Recent context at SessionStart is ${p.startupContext ? 'enabled' : 'off; opt in with --startup-context'}. Set context:false in the profile to disable both recall hooks. Stop and PreCompact capture bounded user/assistant transcript text when enabled. Tools, system messages, sidechains, private-marked messages and injected MemoryKit context are excluded. No background observer runs.\n\nKeep this profile outside untrusted repositories: configured distiller/embedding/recall commands execute as you. Namespace derives from the current Git origin unless explicitly pinned. Shared scopes are read only by these workflows; capture writes only the current project namespace. Use the raw create/supersede API to deliberately curate shared knowledge.\n`,
  };
  for (const name of Object.keys(files))
    if (existsSync(join(output, name)))
      throw new ValidationFailedError('Setup output already exists; choose a new output directory');
  // Preflight every output and generated command before creating the store.
  if (!storeExists(p.store!))
    await initStore({
      path: p.store!,
      storage: p.storage,
      history: { provider: p.history ?? 'git' },
    });
  else {
    const client = await openStore({
      path: p.store!,
      storage: p.storage,
      history: { provider: p.history ?? 'git' },
    });
    await client.close();
  }
  mkdirSync(output, { recursive: true });
  for (const [name, content] of Object.entries(files))
    writeFileSync(join(output, name), content + '\n', { flag: 'wx' });
  return {
    profile: config,
    files: Object.keys(files).map((name) => join(output, name)),
    installed: false,
  };
}

export async function runWorkflow(
  argv: string[],
  io: CliIo,
  deps: CliDeps = { openStore }
): Promise<number> {
  const command = argv[0];
  try {
    const { values: v, positionals } = parseArgs({
      args: argv.slice(1),
      allowPositionals: true,
      options: {
        ...STORAGE_OPTIONS,
        profile: { type: 'string' },
        store: { type: 'string' },
        url: { type: 'string' },
        'token-env': { type: 'string' },
        namespace: { type: 'string' },
        'shared-namespace': { type: 'string', multiple: true },
        input: { type: 'string' },
        output: { type: 'string' },
        text: { type: 'string' },
        capture: { type: 'boolean' },
        'startup-context': { type: 'boolean' },
        'include-candidates': { type: 'boolean' },
        'max-bytes': { type: 'string' },
        limit: { type: 'string' },
        'expected-revision': { type: 'string' },
        host: { type: 'string' },
        history: { type: 'string' },
        mapping: { type: 'string' },
        'source-id': { type: 'string' },
        project: { type: 'string', multiple: true },
        'dry-run': { type: 'boolean' },
        'text-output': { type: 'boolean' },
        json: { type: 'boolean' },
        help: { type: 'boolean' },
      },
    });
    if (v.help) {
      io.stdout(HELP);
      return 0;
    }
    if (positionals.length !== (command === 'accept' ? 1 : 0))
      throw new ValidationFailedError('Unexpected positional arguments');
    const base =
      v.profile === undefined ? { version: 1 as const } : profile(jsonFile(v.profile, 65536));
    if (
      (v.store !== undefined && v.url !== undefined) ||
      (v.profile !== undefined &&
        [
          v.store,
          v.url,
          v['token-env'],
          v.history,
          v.storage,
          v['storage-plugin'],
          v['storage-options'],
        ].some((value) => value !== undefined))
    ) {
      throw new ValidationFailedError('Use a profile or connection flags, not both');
    }
    const p = profile({
      ...base,
      ...(storageOptions(v) === undefined ? {} : { storage: storageOptions(v) }),
      ...(v.store === undefined ? {} : { store: resolve(v.store) }),
      ...(v.url === undefined ? {} : { url: v.url }),
      ...(v['token-env'] === undefined ? {} : { tokenEnv: v['token-env'] }),
      ...(v.namespace === undefined ? {} : { namespace: v.namespace }),
      ...(v['shared-namespace'] === undefined ? {} : { sharedNamespaces: v['shared-namespace'] }),
      ...(v.history === undefined ? {} : { history: v.history }),
      ...(v.capture === undefined ? {} : { capture: v.capture }),
      ...(v['startup-context'] === undefined ? {} : { startupContext: v['startup-context'] }),
      ...(v['include-candidates'] === undefined
        ? {}
        : { includeCandidates: v['include-candidates'] }),
      ...(v['max-bytes'] === undefined ? {} : { maxBytes: Number(v['max-bytes']) }),
      ...(v.limit === undefined ? {} : { limit: Number(v.limit) }),
    });
    const print = (value: unknown): void => io.stdout(JSON.stringify(value) + '\n');
    if (command === 'setup' || command === 'upgrade') {
      if (
        !p.store ||
        p.url ||
        !v.output ||
        (command === 'setup'
          ? v.profile !== undefined
          : v.profile === undefined || !storeExists(p.store))
      )
        throw new ValidationFailedError(
          'setup needs --store and --output; upgrade needs an existing --profile and a new --output'
        );
      const output = resolve(v.output);
      quoted(output);
      print(await setup(p, output));
      return 0;
    }
    const event = command === 'hook' ? parseHookEvent(readBounded(0, 65536)) : undefined;
    const prompt =
      event?.hook_event_name === 'UserPromptSubmit' ? promptQuery(event.prompt!) : undefined;
    if (command === 'hook') {
      if (v.profile === undefined)
        throw new ValidationFailedError('Hooks require an explicit profile');
      if (v.host !== 'claude-code' && v.host !== 'codex')
        throw new ValidationFailedError('Unsupported hook host');
      if (
        event!.hook_event_name === 'SessionStart' || event!.hook_event_name === 'UserPromptSubmit'
          ? p.context === false ||
            (event!.hook_event_name === 'SessionStart' && p.startupContext !== true) ||
            (event!.hook_event_name === 'UserPromptSubmit' && prompt!.text === undefined)
          : p.capture !== true || event!.stop_hook_active === true
      )
        return 0;
      if (prompt?.truncated)
        io.stderr(
          'MemoryKit recall query uses the first 1024 characters of the normalized prompt.\n'
        );
    }
    const namespace =
      p.namespace ??
      (command === 'import-claude-mem' ? 'import' : projectNamespace(event?.cwd ?? process.cwd()));
    const contextInput: ContextInput = {
      namespace,
      sharedNamespaces: p.sharedNamespaces,
      text: prompt === undefined ? v.text : prompt.text,
      includeCandidates: p.includeCandidates,
      maxBytes: p.maxBytes,
      limit: p.limit,
    };
    const local = p.store !== undefined;
    if (!local && p.url === undefined)
      throw new ValidationFailedError('Specify --store, --url or a profile');
    let token: string | undefined;
    if (p.tokenEnv !== undefined) {
      if (local) throw new ValidationFailedError('tokenEnv requires a remote URL');
      token = (deps.env ?? process.env)[p.tokenEnv];
      if (!token)
        throw new ValidationFailedError('The configured token environment variable is not set');
    }
    const client = local
      ? await deps.openStore({
          path: p.store!,
          storage: p.storage,
          history: { provider: p.history ?? 'git' },
        })
      : Object.assign((deps.connect ?? connect)(p.url!, token === undefined ? {} : { token }), {
          close: async () => {},
        });
    try {
      if (command === 'doctor') {
        print({
          ok: true,
          status: await client.status(),
          profile: {
            local,
            namespace,
            capture: p.capture === true,
            recall: p.recall?.id ?? null,
            discovery: p.recall?.discovery === true,
            verification: p.recall?.verification === true,
          },
          runtime: { node: process.version, cli: fileURLToPath(import.meta.url) },
        });
        return 0;
      }
      const distiller = p.distiller === undefined ? undefined : new CommandDistiller(p.distiller);
      const embedding =
        p.embedding === undefined
          ? undefined
          : new CommandEmbeddings(p.embedding.id, p.embedding.command);
      if (
        command === 'context' ||
        (command === 'hook' &&
          ['SessionStart', 'UserPromptSubmit'].includes(event!.hook_event_name))
      ) {
        const selector =
          p.recall === undefined
            ? undefined
            : new CommandRecallSelector(
                p.recall.id,
                p.recall.command,
                p.recall.discovery,
                p.recall.verification
              );
        const result = await context(client, contextInput, embedding, selector);
        if (command === 'hook') {
          if (result.text)
            print({
              hookSpecificOutput: {
                hookEventName: event!.hook_event_name,
                additionalContext: result.text,
              },
            });
          if (result.completeness === 'partial')
            io.stderr('MemoryKit context is partial: ' + result.reasons.join(', ') + '\n');
        } else if (v['text-output']) io.stdout(result.text + (result.text ? '\n' : ''));
        else print(result);
        return 0;
      }
      if (command === 'hook') {
        const transcript = readTranscript(v.host as Host, event!, namespace);
        if (transcript.truncated || transcript.skipped)
          io.stderr(
            'MemoryKit captured a bounded transcript selection; some source data was omitted.\n'
          );
        if (transcript.input === null) return 0;
        if (distiller !== undefined)
          transcript.input.source.eventId =
            'distillation:' + sha256Hex(JSON.stringify(transcript.input.observations));
        const result = await capture(client, transcript.input, distiller);
        if (result.completeness === 'partial') {
          io.stderr(JSON.stringify({ code: 'CapturePartial', failures: result.failures }) + '\n');
          return 1;
        }
        return 0;
      }
      if (command === 'capture') {
        if (!v.input) throw new ValidationFailedError('capture needs --input');
        const input = jsonFile(v.input) as CaptureInput;
        planCapture(input);
        if (input.namespace !== namespace)
          throw new ValidationFailedError(
            'Capture namespace must match the selected project namespace'
          );
        const result = await capture(client, input, distiller);
        print(result);
        return result.completeness === 'partial' ? 1 : 0;
      }
      if (command === 'accept') {
        const revision = integer(
          Number(v['expected-revision']),
          'expected-revision',
          0,
          1,
          Number.MAX_SAFE_INTEGER
        );
        const record = await client.get(positionals[0]!);
        if (record.namespace !== namespace)
          throw new ValidationFailedError(
            'Accept namespace must match the selected project namespace'
          );
        print(await accept(client, record.id, revision));
        return 0;
      }
      if (command === 'import-claude-mem') {
        if (!v.input || !v.mapping || !v['source-id'])
          throw new ValidationFailedError('Import needs --input, --mapping and --source-id');
        const options: ClaudeMemImportOptions = {
          sourceId: v['source-id'],
          projectNamespaces: jsonFile(v.mapping, 65536) as Record<string, string>,
          projects: v.project,
        };
        const data = jsonFile(v.input);
        if (v['dry-run']) {
          const plan = planClaudeMemImport(data, options);
          print({
            dryRun: true,
            counts: plan.counts,
            namespaces: [...new Set(plan.captures.map((c) => c.namespace))],
          });
          return 0;
        }
        const result = await importClaudeMem(client, data, options);
        print(result);
        return result.completeness === 'partial' ? 1 : 0;
      }
      throw new ValidationFailedError('Unknown workflow command');
    } finally {
      await client.close();
    }
  } catch (error) {
    io.stderr(JSON.stringify(toProblem(error)) + '\n');
    // Exit 2 can block a host operation. All hook failures are non-blocking exit 1.
    return 1;
  }
}
