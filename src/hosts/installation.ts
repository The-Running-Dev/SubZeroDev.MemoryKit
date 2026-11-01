// Local administrator operations. Only groups recorded in our manifest are owned.
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { canonicalJson, isPlainObject, sha256Hex, ValidationFailedError } from '../model/index.ts';

type Groups = Record<string, unknown[]>;
interface Manifest {
  version: 1;
  host: string;
  settings: string;
  profile: string;
  groups: Groups;
}
const read = (path: string): string | null => {
  if (!existsSync(path)) return null;
  if (statSync(path).size > 1024 * 1024)
    throw new ValidationFailedError('Host configuration exceeds 1 MiB');
  return readFileSync(path, 'utf8');
};
function json(raw: string | null): Record<string, unknown> {
  const value: unknown = raw === null ? {} : JSON.parse(raw.replace(/^\uFEFF/, ''));
  if (!isPlainObject(value))
    throw new ValidationFailedError('Host configuration must be a JSON object');
  return value;
}
function groups(value: unknown): Groups {
  if (!isPlainObject(value) || Object.values(value).some((g) => !Array.isArray(g)))
    throw new ValidationFailedError('Host hooks must be event arrays');
  return value as Groups;
}
function manifest(path: string, host: string, settings: string, profile: string): Manifest | null {
  const raw = read(path);
  if (raw === null) return null;
  const m = json(raw);
  if (m.version !== 1 || m.host !== host || m.settings !== settings || m.profile !== profile)
    throw new ValidationFailedError(
      'Installation manifest does not match host, settings and profile'
    );
  groups(m.groups);
  return m as unknown as Manifest;
}
function replace(path: string, before: string | null, value: unknown): void {
  if (read(path) !== before)
    throw new ValidationFailedError('Configuration changed; retry installation');
  mkdirSync(dirname(path), { recursive: true });
  const suffix = '.memorykit-' + randomUUID();
  // A backup is retained for manual recovery; never restore the whole file during uninstall.
  if (before !== null) writeFileSync(path + suffix + '.bak', before, { flag: 'wx', mode: 0o600 });
  const staging = path + suffix + '.tmp';
  writeFileSync(staging, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  renameSync(staging, path);
}
export function installationPaths(profile: string, host: string, settings: string, path?: string) {
  const paths = {
    profile: resolve(profile),
    host,
    settings: resolve(settings),
    manifest: resolve(path ?? profile + '.' + host + '.installation.json'),
  };
  const names = [paths.profile, paths.settings, paths.manifest].map((p) =>
    process.platform === 'win32' ? p.toLowerCase() : p
  );
  if (new Set(names).size !== names.length)
    throw new ValidationFailedError('Profile, settings and manifest must be different files');
  return paths;
}
export type InstallationPaths = ReturnType<typeof installationPaths>;

export function installHooks(paths: InstallationPaths, desired: Groups, uninstall = false): object {
  mkdirSync(dirname(paths.settings), { recursive: true });
  const lock = paths.settings + '.memorykit.lock';
  let fd: number;
  try {
    fd = openSync(lock, 'wx', 0o600);
  } catch {
    throw new ValidationFailedError(
      'Another installation is running; inspect the settings lock before retrying'
    );
  }
  try {
    return applyHooks(paths, desired, uninstall);
  } finally {
    closeSync(fd);
    unlinkSync(lock);
  }
}
function applyHooks(paths: InstallationPaths, desired: Groups, uninstall: boolean): object {
  const before = read(paths.settings),
    originalManifest = read(paths.manifest);
  const config = json(before);
  const hooks = structuredClone(groups(config.hooks ?? {}));
  const owned = manifest(paths.manifest, paths.host, paths.settings, paths.profile);
  // Preflight every old group before changing anything. Never guess ownership by command name.
  for (const [event, entries] of Object.entries(owned?.groups ?? {})) {
    for (const entry of entries) {
      const list = hooks[event] ?? [];
      const matches = list.flatMap((g, i) =>
        canonicalJson(g) === canonicalJson(entry) ? [i] : []
      );
      if (matches.length !== 1)
        throw new ValidationFailedError(
          'Owned hooks changed or are missing; reconcile the manifest before replacing them'
        );
      list.splice(matches[0]!, 1);
      if (list.length) hooks[event] = list;
      else delete hooks[event];
    }
  }
  if (uninstall && (!owned || !Object.keys(owned.groups).length))
    return { installed: false, changed: false };
  if (!uninstall) {
    for (const [event, entries] of Object.entries(groups(desired))) {
      const list = hooks[event] ?? [];
      for (const entry of entries) {
        if (list.some((g) => canonicalJson(g) === canonicalJson(entry)))
          throw new ValidationFailedError(
            'Matching unowned hook already exists; remove the manual fragment before installing'
          );
        list.push(entry);
      }
      hooks[event] = list;
    }
  }
  config.hooks = hooks;
  const next: Manifest = {
    version: 1,
    host: paths.host,
    settings: paths.settings,
    profile: paths.profile,
    groups: uninstall ? {} : desired,
  };
  if (
    canonicalJson(config) === canonicalJson(json(before)) &&
    originalManifest !== null &&
    canonicalJson(next) === canonicalJson(json(originalManifest))
  )
    return {
      installed: !uninstall,
      changed: false,
      settings: paths.settings,
      manifest: paths.manifest,
      trustReviewRequired: !uninstall && paths.host === 'codex',
    };
  // Each file is replaced atomically. Retain backups for interrupted cross-file updates.
  replace(paths.settings, before, config);
  try {
    replace(paths.manifest, originalManifest, next);
  } catch {
    // Roll back only if no external editor has changed the settings we just wrote.
    if (canonicalJson(json(read(paths.settings))) === canonicalJson(config)) {
      if (before === null) unlinkSync(paths.settings);
      else replace(paths.settings, read(paths.settings), json(before));
    }
    throw new ValidationFailedError(
      'Installation manifest failed; settings rollback attempted; inspect the retained backups'
    );
  }
  return {
    installed: !uninstall,
    changed: before !== read(paths.settings),
    settings: paths.settings,
    manifest: paths.manifest,
    trustReviewRequired: !uninstall && paths.host === 'codex',
  };
}

export function inspectInstallation(paths: InstallationPaths): {
  configured: boolean;
  fingerprint: string;
  groups: Groups;
} {
  const owned = manifest(paths.manifest, paths.host, paths.settings, paths.profile);
  const actual = groups(json(read(paths.settings)).hooks ?? {});
  const expected = owned?.groups ?? {};
  const configured =
    Object.keys(expected).length > 0 &&
    Object.entries(expected).every(([event, entries]) =>
      entries.every(
        (entry) =>
          (actual[event] ?? []).filter((g) => canonicalJson(g) === canonicalJson(entry)).length ===
          1
      )
    );
  return { configured, fingerprint: sha256Hex(canonicalJson(expected)), groups: expected };
}
