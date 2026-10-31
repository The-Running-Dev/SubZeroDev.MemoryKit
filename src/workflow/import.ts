import {
  canonicalJson,
  isPlainObject,
  parseNamespace,
  ValidationFailedError,
} from '../model/index.ts';
import type { MemoryClient } from '../service/index.ts';
import { capture, nonempty, planCapture, type CaptureInput, type CaptureResult } from './index.ts';

export interface ClaudeMemImportOptions {
  // A stable identity for the source installation, not the export filename or timestamp.
  sourceId: string;
  projectNamespaces: Record<string, string>;
  projects?: string[];
}
export interface ClaudeMemImportPlan {
  format: 'claude-mem-json';
  captures: CaptureInput[];
  counts: { observations: number; summaries: number; prompts: number; excluded: number };
}

// Compatible with thedotmack/claude-mem's export-memories JSON envelope. Keep original
// rows intact rather than guessing which structured facts or file references matter.
export function planClaudeMemImport(
  data: unknown,
  options: ClaudeMemImportOptions
): ClaudeMemImportPlan {
  nonempty(options.sourceId, 'sourceId', 256);
  if (
    !isPlainObject(data) ||
    !isPlainObject(options.projectNamespaces) ||
    !['observations', 'summaries', 'prompts'].some((table) => Array.isArray(data[table]))
  ) {
    throw new ValidationFailedError(
      'Expected a claude-mem JSON export and explicit projectNamespaces'
    );
  }
  Object.values(options.projectNamespaces).forEach(parseNamespace);
  if (
    options.projects !== undefined &&
    (!Array.isArray(options.projects) || options.projects.some((p) => typeof p !== 'string'))
  ) {
    throw new ValidationFailedError('Invalid projects filter');
  }
  const sessions = data.sessions ?? [];
  if (!Array.isArray(sessions) || sessions.some((s) => !isPlainObject(s)))
    throw new ValidationFailedError('Invalid exported sessions');
  const plan: ClaudeMemImportPlan = {
    format: 'claude-mem-json',
    captures: [],
    counts: { observations: 0, summaries: 0, prompts: 0, excluded: 0 },
  };
  const identities = new Set<string>();
  for (const table of ['observations', 'summaries', 'prompts'] as const) {
    const rows = data[table] ?? [];
    if (!Array.isArray(rows) || rows.length > 10000)
      throw new ValidationFailedError('Invalid or oversized export table');
    for (const row of rows) {
      if (
        !isPlainObject(row) ||
        !(typeof row.id === 'string' || (Number.isSafeInteger(row.id) && (row.id as number) > 0))
      ) {
        throw new ValidationFailedError('Every imported row needs a stable id');
      }
      const id = `${table}:${String(row.id)}`;
      if (identities.has(id)) throw new ValidationFailedError('Duplicate exported row id');
      identities.add(id);
      // Prompts in some exports carry project only on their SDK-session parent. Ambiguous
      // joins fail closed; a session from another project must never supply ownership.
      const parents = sessions.filter(
        (s: Record<string, unknown>) =>
          (row.memory_session_id != null && s.memory_session_id === row.memory_session_id) ||
          (row.session_db_id != null && s.id === row.session_db_id) ||
          (row.content_session_id != null && s.content_session_id === row.content_session_id)
      );
      const projects = new Set(
        [row.project, ...parents.map((s: Record<string, unknown>) => s.project)].filter(
          (p): p is string => typeof p === 'string' && p !== ''
        )
      );
      if (projects.size !== 1)
        throw new ValidationFailedError('Imported row has missing or ambiguous project ownership');
      const project = [...projects][0]!;
      if (options.projects !== undefined && !options.projects.includes(project)) {
        plan.counts.excluded++;
        continue;
      }
      const namespace = Object.hasOwn(options.projectNamespaces, project)
        ? options.projectNamespaces[project]
        : undefined;
      if (namespace === undefined)
        throw new ValidationFailedError(
          'Every selected project needs an explicit namespace mapping'
        );
      const sourceRef = `claude-mem:${encodeURIComponent(options.sourceId)}/${table}/${encodeURIComponent(String(row.id))}`;
      plan.captures.push({
        namespace,
        source: { host: 'claude-mem', sessionId: options.sourceId, eventId: id, ref: sourceRef },
        observations: [
          {
            id: 'row',
            role: table === 'prompts' ? 'user' : 'assistant',
            generated: table !== 'prompts',
            kind:
              table === 'summaries' ? 'handoff' : table === 'prompts' ? 'source' : 'observation',
            content: canonicalJson(row),
          },
        ],
      });
      plan.counts[table]++;
    }
  }
  if (plan.captures.length > 10000)
    throw new ValidationFailedError('Export exceeds 10000 selected rows');
  plan.captures.forEach(planCapture);
  return plan;
}

export async function importClaudeMem(
  client: MemoryClient,
  data: unknown,
  options: ClaudeMemImportOptions
): Promise<CaptureResult & { counts: ClaudeMemImportPlan['counts'] }> {
  const plan = planClaudeMemImport(data, options);
  const result: CaptureResult & { counts: ClaudeMemImportPlan['counts'] } = {
    counts: plan.counts,
    items: [],
    failures: [],
    completeness: 'complete',
  };
  for (const input of plan.captures) {
    const batch = await capture(client, input);
    result.items.push(...batch.items);
    result.failures.push(...batch.failures);
    if (batch.completeness === 'partial') result.completeness = 'partial';
  }
  return result;
}
