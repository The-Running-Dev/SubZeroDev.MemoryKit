import type {
  BoundaryResult,
  HistoryEntry,
  HistoryProvider,
  ProviderDescriptor,
  RevisionSnapshot,
  RevisionSummary,
} from '../contracts/index.ts';
import { InternalError, type MemoryId, type Namespace } from '../model/index.ts';

// History held in process memory, for tests and for consumers that want no Git. Nothing
// survives the process.
export class MemoryHistory implements HistoryProvider {
  readonly descriptor: ProviderDescriptor = {
    id: 'history-memory',
    version: '0.1.0',
    contractVersions: [1],
    capabilities: ['history.record'],
    limitations: ['not-durable'],
  };

  private readonly entries = new Map<
    string,
    { namespace: Namespace; snapshot: RevisionSnapshot }
  >();

  async open(): Promise<void> {}

  async close(): Promise<void> {}

  // Keyed by operation, memory and revision: one operation can record several memories, and
  // recording the same entry again returns its first ref.
  async record(entry: HistoryEntry): Promise<{ historyRef: string }> {
    const key = `${entry.operationId}\0${entry.memoryId}\0${entry.revision}`;
    const existing = this.entries.get(key);
    if (existing) return { historyRef: existing.snapshot.historyRef };
    if (entry.payload === null) {
      throw new InternalError('A history entry has no snapshot', { seq: entry.seq });
    }
    const historyRef = `mem:${this.entries.size + 1}`;
    this.entries.set(key, {
      namespace: entry.namespace,
      snapshot: {
        revision: entry.revision,
        operation: entry.operation,
        operationId: entry.operationId,
        actor: entry.actor,
        at: entry.at,
        historyRef,
        record: structuredClone(entry.payload),
      },
    });
    return { historyRef };
  }

  async list(memoryId: MemoryId, ns: Namespace): Promise<RevisionSummary[]> {
    return this.revisions(memoryId, ns).map(
      ({ revision, operation, operationId, actor, at, historyRef }) => ({
        revision,
        operation,
        operationId,
        actor,
        at,
        historyRef,
      })
    );
  }

  async get(memoryId: MemoryId, ns: Namespace, revision: number): Promise<RevisionSnapshot | null> {
    const found = this.revisions(memoryId, ns).find((item) => item.revision === revision);
    return found ? structuredClone(found) : null;
  }

  // Purge arrives in S11.
  purgeCoverage(): Record<
    'history_current_tree' | 'history_past_revisions' | 'history_remotes',
    BoundaryResult
  > {
    return {
      history_current_tree: 'unsupported',
      history_past_revisions: 'unsupported',
      history_remotes: 'unsupported',
    };
  }

  private revisions(memoryId: MemoryId, ns: Namespace): RevisionSnapshot[] {
    return [...this.entries.values()]
      .filter((item) => item.namespace === ns && item.snapshot.record.id === memoryId)
      .map((item) => item.snapshot)
      .sort((a, b) => a.revision - b.revision);
  }
}
