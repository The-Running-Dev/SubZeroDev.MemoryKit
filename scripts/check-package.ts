// S12.1 and S12.2: packs the package, installs the tarball into an empty directory, runs the
// installed CLI end to end, then type-checks and runs the consumer against the install.
//
//   node scripts/check-package.ts

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectArchiveFile } from './check-archive.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// npm and npx are .cmd shims on Windows, which only a shell runs; the shell is handed one
// command line, so no argument may contain a space.
function run(command: string, args: string[], cwd: string): string {
  const shell = process.platform === 'win32' && !command.endsWith('.exe');
  const result = shell
    ? spawnSync([command, ...args].join(' '), { cwd, encoding: 'utf8', shell })
    : spawnSync(command, args, { cwd, encoding: 'utf8' });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed:\n${output}`);
  return result.stdout;
}

const work = mkdtempSync(join(tmpdir(), 'memorykit-package-'));
try {
  const supplied = process.argv[2] ? resolve(process.argv[2]) : undefined;
  if (!supplied) run('npm', ['pack', '--silent', '--pack-destination', work], ROOT);
  const packed = readdirSync(work).find((name) => name.endsWith('.tgz'));
  assert.ok(supplied || packed, 'npm pack wrote no tarball');
  const tarball = supplied ?? join(work, packed!);
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const archive = inspectArchiveFile(tarball, manifest);
  console.log(
    `archive ok: ${archive.files.length} files, ${archive.bytes} bytes, sha256 ${archive.sha256}`
  );

  const app = join(work, 'app');
  mkdirSync(app);
  writeFileSync(
    join(app, 'package.json'),
    JSON.stringify({ name: 'consumer', private: true, type: 'module' })
  );
  run('npm', ['install', '--no-audit', '--no-fund', tarball], app);

  // The installed executable, end to end.
  const memorykit = (...args: string[]) => run('npx', ['--no-install', 'memorykit', ...args], app);
  memorykit('init', 'store');
  const created = memorykit(
    'create',
    '--store',
    'store',
    '--namespace',
    'demo',
    '--kind',
    'note',
    '--content',
    'installed'
  );
  const id = created.trim().split(' ')[0]!;
  assert.match(memorykit('get', id, '--store', 'store'), /installed/);
  console.log('cli ok');

  // A scoped identity changes resolution paths but never the executable name.
  // The consumer, type-checked against the installed declarations, then run.
  const consumers = ['consumer.ts', 'history-modules.ts', 'git-history.ts'];
  for (const file of consumers) {
    copyFileSync(join(ROOT, 'tests', 'consumer', file), join(app, file));
  }
  writeFileSync(
    join(app, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2023',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        noEmit: true,
        types: ['node'],
        typeRoots: [join(ROOT, 'node_modules', '@types')],
      },
      files: consumers,
    })
  );
  run(process.execPath, [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', '.'], app);
  // Separate processes: a previously imported Git provider must not hide an eager root import.
  for (const provider of ['memory', 'none']) {
    console.log(
      run(process.execPath, ['--no-warnings', 'history-modules.ts', provider], app).trim()
    );
  }
  console.log(run(process.execPath, ['--no-warnings', 'consumer.ts'], app).trim());
  console.log(run(process.execPath, ['--no-warnings', 'git-history.ts'], app).trim());
  assert.equal(
    inspectArchiveFile(tarball, manifest).sha256,
    archive.sha256,
    'archive changed during consumer checks'
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
