import { CachedRecallSelector } from '../workflow/recall-cache.ts';
import { assessReadiness, probeRecall } from '../workflow/readiness.ts';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  writeFileSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { installationPaths, installHooks, inspectInstallation } from '../hosts/installation.ts';
import { reviewMemory, reviewQueue } from '../workflow/review.ts';
import { browse } from '../workflow/browse.ts';
import {
  parseHookEvent,
  projectNamespace,
  promptQuery,
  readTranscript,
  type Host,
} from '../hosts/index.ts';
import { canonicalJson, sha256Hex, toProblem, ValidationFailedError } from '../model/index.ts';
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
  reconcileClaudeMem,
  planClaudeMemImport,
  type ClaudeMemImportOptions,
} from '../workflow/import.ts';
import {
  gitSourceStatus,
  planGitSource,
  validateGitSource,
  type GitSourceConfig,
} from '../workflow/git-source.ts';
import {
  dueSources,
  inspectSources,
  leaseHeld,
  readSourceStates,
  syncConfiguredSource,
  syncDueSources,
  type SourceRuntime,
} from '../workflow/source-runner.ts';
import type { CliDeps, CliIo } from './run.ts';

export const WORKFLOW_COMMANDS = [
  'setup',
  'upgrade',
  'doctor',
  'install',
  'uninstall',
  'review',
  'index-clear',
  'recall-cache-clear',
  'capture',
  'context',
  'browse',
  'accept',
  'import-claude-mem',
  'reconcile-claude-mem',
  'source',
  'hook',
];
const HELP = `MemoryKit portable workflows:
  setup --store <dir> --output <dir> [--namespace <ns>] [--shared-namespace <ns>]...
        [--capture] [--include-candidates] [--startup-context] [--history git|none]
        [--storage sqlite|markdown | --storage-plugin <absolute-module> [--storage-options <json>]]
    Creates a new store if absent and writes a profile plus host configuration fragments.
    Use install to activate owned hooks; setup leaves existing host settings untouched.
  upgrade --profile <json> --output <new-dir>
    Regenerates the profile and host fragments using this installed CLI.
  doctor --profile <json>
    Opens the configured store and reports provider, history queue and workflow status.
    --provider-probe explicitly calls the configured model with synthetic data only.
    --readiness <json> assesses quality/native/migration report paths and cold p95 (default 10s).
    Ready also requires --provider-probe and a current --host installation.
  install|uninstall --profile <json> --host claude-code|codex [--settings <json>] [--manifest <json>]
    Installs or replaces owned hook groups; uninstall removes only owned groups.
  doctor --profile <json> --host claude-code|codex [--settings <json>] [--probe]
    Checks installed groups, last hook invocation receipt and optional execution probe.
  review [accept|reject|correct|duplicate <id>] --profile <json> [--cursor <cursor>] [--limit <n>]
    Queue includes content, provenance and duplicate suggestions. Actions need --expected-revision.
    correct needs --text; duplicate needs --duplicate-of <accepted-id>.
  recall-cache-clear --profile <json>
    Logically clears this profile scope's optional sensitive recall cache.
  index-clear --profile <json>
    Clears this profile scope's optional derived vector index.
  capture --profile <json> --input <json|->
  context --profile <json> [--text <query>] [--text-output] [--include-candidates]
  browse --profile <json> [--text <literal-substring>] [--kind <kind>]...
        [--limit <1..50>] [--max-bytes <512..65536>] [--preview-chars <0..256>] [--cursor <cursor>]
    Returns bounded metadata, no content by default. Candidate browsing needs --include-candidates.
  accept <id> --profile <json> --expected-revision <n>
  import-claude-mem --profile <json> --input <json|-> --mapping <json>
        --source-id <stable-installation-id> [--project <source-project>]... [--dry-run]
  reconcile-claude-mem --profile <json> --input <json|-> --mapping <json>
        --source-id <stable-installation-id> [--project <source-project>]...
    Audits selected source coverage without changing reviewed records.
  source plan|sync|status --profile <json> --source <id>
    Follows a configured Git source (profile sources[]). plan lists what the tip would create or
    skip and writes nothing; sync reconciles the store with the tip (updates, supersedes renames,
    archives deletions, reports conflicts) and a repeat is a no-op; status reports the ref, last
    applied commit, lag and counts, never document content. The cursor lives beside the profile
    as <profile>.sources.json and is only an optimization.
    sync --due syncs every auto source whose tip moved, under one lease (a sync already running
    is skipped); sources may set auto (follow on SessionStart) and fetch (a remote to fetch first).
  hook --profile <json> --host claude-code|codex  (host event JSON on stdin)

Instead of --profile, capture/context/browse/accept/import accept --store <dir> or --url <url>
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
  sources?: GitSourceConfig[];
  distiller?: CommandProviderOptions;
  embedding?: { id: string; command: CommandProviderOptions; index?: string };
  recall?: {
    id: string;
    command: CommandProviderOptions;
    discovery?: boolean;
    verification?: boolean;
    retries?: number;
    cache?: string;
    deadlineMs?: number;
    budget?: { passages: number; passageChars: number; bytes: number };
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
      'sources',
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
  if (p.sources !== undefined) {
    if (!Array.isArray(p.sources) || p.sources.length > 32)
      throw new ValidationFailedError('Invalid workflow profile sources');
    const ids = new Set<string>();
    for (const source of p.sources) {
      validateGitSource(source);
      if (ids.has(source.id)) throw new ValidationFailedError('Duplicate source id');
      ids.add(source.id);
    }
  }
  if (p.distiller !== undefined) validateCommand(p.distiller);
  for (const provider of [p.embedding, p.recall]) {
    if (provider === undefined) continue;
    fields(
      provider,
      [
        'id',
        'command',
        ...(provider === p.recall
          ? ['discovery', 'verification', 'retries', 'cache', 'deadlineMs', 'budget']
          : ['index']),
      ],
      ['id', 'command']
    );
    if (typeof provider.id !== 'string' || provider.id.trim() === '' || provider.id.length > 256)
      throw new ValidationFailedError('Provider needs an id');
    validateCommand(provider.command);
  }
  if (
    p.embedding?.index !== undefined &&
    (typeof p.embedding.index !== 'string' || !isAbsolute(p.embedding.index))
  )
    throw new ValidationFailedError('Embedding index needs an absolute path');
  if (
    p.recall?.cache !== undefined &&
    (typeof p.recall.cache !== 'string' || !isAbsolute(p.recall.cache))
  )
    throw new ValidationFailedError('Recall cache needs an absolute path');
  if (p.recall?.retries !== undefined && ![0, 1].includes(p.recall.retries))
    throw new ValidationFailedError('Recall retries must be 0 or 1');
  integer(p.recall?.deadlineMs, 'recall.deadlineMs', 60000, 1, 120000);
  if (p.recall?.budget !== undefined) {
    fields(
      p.recall.budget,
      ['passages', 'passageChars', 'bytes'],
      ['passages', 'passageChars', 'bytes']
    );
    integer(p.recall.budget.passages, 'budget.passages', 32, 1, 32);
    integer(p.recall.budget.passageChars, 'budget.passageChars', 2048, 128, 2048);
    integer(p.recall.budget.bytes, 'budget.bytes', 65536, 1024, 65536);
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
  const hook = (host: Host): object => hostHooks(p, config, host);
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
    'README.md': `# MemoryKit host setup\n\nProfile: ${config}\n\nRun memorykit install --profile "${config}" --host claude-code or codex to merge owned hook groups, preserving other settings. In Codex, review and trust hooks through /hooks. Regenerate owned hooks with install after package/profile changes. Use uninstall with the same profile and host to remove them. MCP fragments use the common JSON server format; adapt to your host. Capture is ${p.capture ? 'enabled' : 'off'}; candidates are ${p.includeCandidates ? 'included as unverified' : 'excluded'}. Keep configuration outside untrusted repositories.\n`,
  };
  for (const name of Object.keys(files))
    if (existsSync(join(output, name)))
      throw new ValidationFailedError('Setup output already exists; choose a new output directory');
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
    writeFileSync(join(output, name), content + '\n', { flag: 'wx', mode: 0o600 });
  return {
    profile: config,
    files: Object.keys(files).map((name) => join(output, name)),
    installed: false,
  };
}
const hasAutoSources = (p: Profile): boolean => p.sources?.some((s) => s.auto === true) === true;

function sourceRuntime(p: Profile, profilePath: string | undefined): SourceRuntime {
  return {
    sources: p.sources ?? [],
    ...(profilePath === undefined ? {} : { stateFile: `${resolve(profilePath)}.sources.json` }),
  };
}

// SessionStart: one cheap check per auto source, then at most one detached sync. The lease
// check keeps a second host from spawning, and the child takes the lease itself. Any failure
// here is swallowed: a host session never waits on, or fails because of, a source sync.
function startDueSync(p: Profile, profilePath: string): void {
  try {
    if (!hasAutoSources(p)) return;
    const runtime = sourceRuntime(p, profilePath);
    if (leaseHeld(runtime.stateFile!)) return;
    if (dueSources(runtime.sources, readSourceStates(runtime.stateFile)).length === 0) return;
    const cli = fileURLToPath(
      new URL('./main' + (import.meta.url.endsWith('.ts') ? '.ts' : '.js'), import.meta.url)
    );
    const child = spawn(
      process.execPath,
      [cli, 'source', 'sync', '--due', '--profile', profilePath],
      { detached: true, stdio: 'ignore', windowsHide: true }
    );
    child.on('error', () => {});
    child.unref();
  } catch {
    /* Nonblocking by design. */
  }
}

// The configured sources of a workflow profile, for `serve` and `mcp` to expose by id.
export function loadSourceRuntime(file: string): SourceRuntime {
  return sourceRuntime(profile(jsonFile(file, 65536)), file);
}

function hostHooks(p: Profile, config: string, host: Host): { hooks: Record<string, unknown[]> } {
  const cli = fileURLToPath(
    new URL('./main' + (import.meta.url.endsWith('.ts') ? '.ts' : '.js'), import.meta.url)
  );
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
              // Leave time for shell/Node startup, opening the store and closing receipts.
              // The workflow/provider deadline itself remains unchanged.
              group(Math.ceil((p.recall?.deadlineMs ?? 60000) / 1000) + 30),
            ],
          }),
      ...((p.context !== false && p.startupContext === true) || hasAutoSources(p)
        ? { SessionStart: [group(30)] }
        : {}),
      ...(p.capture ? { Stop: [group(60)], PreCompact: [group(60)] } : {}),
    },
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
        kind: { type: 'string', multiple: true },
        'preview-chars': { type: 'string' },
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
        source: { type: 'string' },
        due: { type: 'boolean' },
        'text-output': { type: 'boolean' },
        json: { type: 'boolean' },
        settings: { type: 'string' },
        manifest: { type: 'string' },
        probe: { type: 'boolean' },
        'provider-probe': { type: 'boolean' },
        readiness: { type: 'string' },
        cursor: { type: 'string' },
        'duplicate-of': { type: 'string' },
        help: { type: 'boolean' },
      },
    });
    if (v.help) {
      io.stdout(HELP);
      return 0;
    }
    if (
      positionals.length !==
      (command === 'accept' || command === 'source'
        ? 1
        : command === 'review'
          ? positionals.length
            ? 2
            : 0
          : 0)
    )
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
      ...(v.limit === undefined || command === 'review' ? {} : { limit: Number(v.limit) }),
    });
    const print = (value: unknown): void => io.stdout(JSON.stringify(value) + '\n');
    const hostPaths = () => {
      if (!v.profile || !['claude-code', 'codex'].includes(v.host ?? ''))
        throw new ValidationFailedError(
          'Host administration needs --profile and --host claude-code|codex'
        );
      return installationPaths(
        v.profile,
        v.host!,
        v.settings ??
          join(homedir(), v.host === 'codex' ? '.codex/hooks.json' : '.claude/settings.json'),
        v.manifest
      );
    };
    if (command === 'install' || command === 'uninstall') {
      const paths = hostPaths();
      print(
        installHooks(
          paths,
          hostHooks(p, paths.profile, v.host as Host).hooks,
          command === 'uninstall'
        )
      );
      return 0;
    }
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
      const probe = process.env.MEMORYKIT_HOOK_PROBE;
      if (probe && /^[a-f0-9]{64}$/.test(probe)) {
        print({ memorykitProbe: probe });
        return 0;
      }
      // Local diagnostic receipt contains no prompts, content, namespaces or credentials.
      // It records invocation, not host trust or successful retrieval.
      const receiptPath = v.profile + '.' + v.host + '.receipt.json';
      const receiptStaging = receiptPath + '.' + randomUUID() + '.tmp';
      try {
        writeFileSync(
          receiptStaging,
          JSON.stringify({
            version: 1,
            host: v.host,
            event: event!.hook_event_name,
            at: new Date().toISOString(),
            cli: fileURLToPath(import.meta.url),
          }) + '\n',
          { mode: 0o600, flag: 'wx' }
        );
        renameSync(receiptStaging, receiptPath);
      } catch {
        /* Host operation remains nonblocking. */
      } finally {
        try {
          unlinkSync(receiptStaging);
        } catch {
          /* Absent after successful replacement. */
        }
      }
      if (event!.hook_event_name === 'SessionStart' && v.profile !== undefined)
        startDueSync(p, resolve(v.profile));
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
      (['import-claude-mem', 'reconcile-claude-mem'].includes(command ?? '')
        ? 'import'
        : projectNamespace(event?.cwd ?? process.cwd()));
    const contextInput: ContextInput = {
      deadlineMs: p.recall?.deadlineMs,
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
      if (command === 'browse') {
        print(
          await browse(client, {
            namespace,
            sharedNamespaces: p.sharedNamespaces,
            text: v.text,
            kinds: v.kind,
            includeCandidates: v['include-candidates'] === true,
            limit: v.limit === undefined ? undefined : Number(v.limit),
            maxBytes: p.maxBytes,
            previewChars: v['preview-chars'] === undefined ? undefined : Number(v['preview-chars']),
            cursor: v.cursor,
          })
        );
        return 0;
      }
      if (command === 'doctor') {
        let installation: object | undefined;
        let ok = true;
        if (v.host !== undefined) {
          const paths = hostPaths();
          const inspected = inspectInstallation(paths);
          const current =
            canonicalJson(inspected.groups) ===
            canonicalJson(hostHooks(p, paths.profile, v.host as Host).hooks);
          const receiptPath = paths.profile + '.' + paths.host + '.receipt.json';
          let probe: boolean | null = null;
          if (v.probe) {
            if (!inspected.configured || !current)
              throw new ValidationFailedError('Probe requires current, installed owned hooks');
            const nonce = sha256Hex(String(Date.now()) + process.pid);
            const first = Object.values(inspected.groups).flat()[0] as {
              hooks: { command: string; args?: string[] }[];
            };
            const hook = first.hooks[0]!;
            const executed = spawnSync(hook.command, hook.args ?? [], {
              shell: hook.args === undefined,
              windowsHide: true,
              timeout: 10000,
              encoding: 'utf8',
              input: JSON.stringify({
                hook_event_name: 'UserPromptSubmit',
                cwd: process.cwd(),
                session_id: 'memorykit-doctor',
                prompt: 'diagnostic',
              }),
              env: { ...process.env, MEMORYKIT_HOOK_PROBE: nonce },
            });
            probe =
              executed.status === 0 &&
              executed.stdout.includes(JSON.stringify({ memorykitProbe: nonce }));
          }
          installation = {
            configured: inspected.configured,
            current,
            executionProbe: probe,
            lastInvocation: existsSync(receiptPath) ? jsonFile(receiptPath, 4096) : null,
            trust: 'Review in host; a command probe does not establish host trust.',
          };
          ok = inspected.configured && current && probe !== false;
        }
        const installationOk = Boolean(v.host) && ok;
        const providerHealth =
          v['provider-probe'] && p.recall
            ? await probeRecall(
                new CommandRecallSelector(
                  p.recall.id,
                  p.recall.command,
                  p.recall.discovery,
                  p.recall.verification,
                  p.recall.retries,
                  p.recall.budget
                ),
                p.recall.deadlineMs
              )
            : null;
        if (v['provider-probe'] && !providerHealth?.passed) ok = false;
        let readiness: object | undefined;
        if (v.readiness) {
          const manifest = jsonFile(resolve(v.readiness));
          fields(
            manifest,
            ['quality', 'nativeCodex', 'nativeClaude', 'replacement', 'maxColdP95Ms'],
            []
          );
          const spec = manifest as Record<string, unknown>;
          const evidence: Record<string, unknown> = {};
          for (const key of ['quality', 'nativeCodex', 'nativeClaude', 'replacement']) {
            if (spec[key] === undefined) continue;
            if (typeof spec[key] !== 'string' || !isAbsolute(spec[key] as string))
              throw new ValidationFailedError('Readiness report paths must be absolute');
            if (existsSync(spec[key] as string)) evidence[key] = jsonFile(spec[key] as string);
          }
          const limit = integer(
            spec.maxColdP95Ms as number | undefined,
            'maxColdP95Ms',
            10000,
            1,
            120000
          );
          const assessed = assessReadiness(p.recall, evidence, limit);
          const blocked = [...assessed.blocked];
          if (!providerHealth?.passed) blocked.push('providerHealth');
          if (!installationOk) blocked.push('localInstallation');
          readiness = { ...assessed, ready: blocked.length === 0, blocked };
          ok = blocked.length === 0;
        }
        const sources = p.sources?.length ? inspectSources(sourceRuntime(p, v.profile)) : undefined;
        if (sources?.some((s) => !s.ok)) ok = false;
        print({
          ok,
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
          ...(v['provider-probe'] ? { providerHealth } : {}),
          ...(readiness ? { readiness } : {}),
          ...(sources ? { sources } : {}),
          ...(installation ? { installation } : {}),
        });
        return ok ? 0 : 1;
      }
      const distiller = p.distiller === undefined ? undefined : new CommandDistiller(p.distiller);
      const embedding =
        p.embedding === undefined
          ? undefined
          : new CommandEmbeddings(p.embedding.id, p.embedding.command);
      if (command === 'review') {
        if (!positionals.length) {
          const queue = await reviewQueue(client, {
            namespace,
            ...(v.cursor ? { cursor: v.cursor } : {}),
            limit: integer(
              v.limit === undefined ? undefined : Number(v.limit),
              'limit',
              20,
              1,
              100
            ),
          });
          if (v.json) print(queue);
          else {
            for (const { memory, duplicateIds } of queue.items)
              io.stdout(
                `${memory.id} r${memory.revision} [${memory.metadata.status}] ${memory.metadata.sourceRole ?? 'unspecified'} / ${memory.metadata.statement ?? 'unspecified'}\n${memory.content}\nSources: ${memory.provenance.evidence.map((e) => e.ref).join(', ') || '(none)'}\nDuplicates: ${duplicateIds.join(', ') || '(none in bounded scan)'}\n\n`
              );
            io.stdout(
              JSON.stringify({
                nextCursor: queue.nextCursor,
                duplicateScanLimited: queue.duplicateScanLimited,
              }) + '\n'
            );
          }
        } else
          print(
            await reviewMemory(client, {
              namespace,
              action: positionals[0] as 'accept' | 'reject' | 'correct' | 'duplicate',
              id: positionals[1]!,
              expectedRevision: Number(v['expected-revision']),
              ...(v.text === undefined ? {} : { content: v.text }),
              ...(v['duplicate-of'] === undefined ? {} : { duplicateOf: v['duplicate-of'] }),
            })
          );
        return 0;
      }
      const openIndex = async () => {
        if (!p.embedding?.index) throw new ValidationFailedError('Profile has no embedding index');
        const { SqliteEmbeddingIndex } = await import('../index-sqlite/index.ts');
        return new SqliteEmbeddingIndex(
          p.embedding.index,
          sha256Hex(
            canonicalJson([
              p.store ?? p.url,
              p.storage ?? null,
              token ? sha256Hex(token) : 'embedded',
              namespace,
              p.sharedNamespaces ?? [],
              p.includeCandidates === true,
              p.embedding.id,
            ])
          )
        );
      };
      const openRecallCache = async () => {
        if (!p.recall?.cache) throw new ValidationFailedError('Profile has no recall cache');
        const { SqliteRecallCache } = await import('../index-sqlite/index.ts');
        return new SqliteRecallCache(
          p.recall.cache,
          sha256Hex(
            canonicalJson([
              'recall-v1',
              p.store ?? p.url,
              p.storage ?? null,
              token ? sha256Hex(token) : 'embedded',
              namespace,
              p.sharedNamespaces ?? [],
              p.includeCandidates === true,
              p.recall,
            ])
          )
        );
      };
      if (command === 'recall-cache-clear') {
        const cache = await openRecallCache();
        try {
          await cache.clear();
        } finally {
          cache.close();
        }
        print({ cleared: true });
        return 0;
      }
      if (command === 'index-clear') {
        const index = await openIndex();
        try {
          await index.retain([]);
        } finally {
          index.close();
        }
        print({ cleared: true });
        return 0;
      }
      if (
        command === 'context' ||
        (command === 'hook' &&
          ['SessionStart', 'UserPromptSubmit'].includes(event!.hook_event_name))
      ) {
        const provider =
          p.recall === undefined
            ? undefined
            : new CommandRecallSelector(
                p.recall.id,
                p.recall.command,
                p.recall.discovery,
                p.recall.verification,
                p.recall.retries,
                p.recall.budget
              );
        const cache = p.recall?.cache ? await openRecallCache() : undefined;
        const selector = provider && cache ? new CachedRecallSelector(provider, cache) : provider;
        let index: Awaited<ReturnType<typeof openIndex>> | undefined;
        const result = await (async () => {
          try {
            index = p.embedding?.index ? await openIndex() : undefined;
            return await context(client, contextInput, embedding, selector, index);
          } finally {
            index?.close();
            cache?.close();
          }
        })();
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
      if (command === 'import-claude-mem' || command === 'reconcile-claude-mem') {
        if (!v.input || !v.mapping || !v['source-id'])
          throw new ValidationFailedError('Import needs --input, --mapping and --source-id');
        const options: ClaudeMemImportOptions = {
          sourceId: v['source-id'],
          projectNamespaces: jsonFile(v.mapping, 65536) as Record<string, string>,
          projects: v.project,
        };
        const data = jsonFile(v.input);
        if (command === 'reconcile-claude-mem') {
          const result = await reconcileClaudeMem(client, data, options);
          print(result);
          return result.ready ? 0 : 1;
        }
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
      if (command === 'source') {
        const action = positionals[0];
        if (action !== 'plan' && action !== 'sync' && action !== 'status')
          throw new ValidationFailedError('source needs plan, sync or status');
        const runtime = sourceRuntime(p, v.profile);
        if (v.due) {
          if (action !== 'sync' || v.source !== undefined)
            throw new ValidationFailedError('--due is only for `source sync` without --source');
          const run = await syncDueSources(client, runtime);
          print(run);
          return run.failures.length > 0 || run.results.some((r) => r.completeness === 'partial')
            ? 1
            : 0;
        }
        const source = p.sources?.find((s) => s.id === v.source);
        if (!source)
          throw new ValidationFailedError('source needs --source naming a configured id');
        const states = readSourceStates(runtime.stateFile);
        if (action === 'status') {
          print(gitSourceStatus(source, states[source.id]));
          return 0;
        }
        if (action === 'plan') {
          const plan = planGitSource(source);
          print({
            dryRun: true,
            source: plan.source,
            commit: plan.commit,
            counts: plan.counts,
            records: plan.records.map((r) => ({
              key: r.input.key,
              namespace: r.input.namespace,
              bytes: r.bytes,
            })),
            skipped: plan.skipped,
          });
          return 0;
        }
        const result = await syncConfiguredSource(client, runtime, source.id);
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
