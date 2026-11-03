// Optional external plugin. Loading the core SDK never imports pg or opens a socket.
import { Pool, type PoolClient } from 'pg';
import { indexedTerms, rowPredicate, selectionTerms, type RowSelection } from '../storage-state/search-index.ts';
import { StateStorage, emptyState, type State, type RecordRow } from '../storage-state/index.ts';
import {
  MemoryKitError,
  StoreBusyError,
  StoreUnavailableError,
  ValidationFailedError,
} from '../model/index.ts';
import type { StoragePluginContext } from '../sdk/storage.ts';

export interface PostgresOptions {
  connectionString: string;
  storeId: string;
  initialize?: boolean;
  timeoutMs?: number;
}

/** Transactional state and a transactionally maintained GIN candidate index. */
export class PostgresStorage extends StateStorage {
  readonly descriptor = {
    id: 'storage-postgres',
    version: '0.2.0',
    contractVersions: [1],
    capabilities: ['search.lexical', 'retrieve.lexical', 'purge.current'],
    limitations: ['serialized-store-writes', 'snapshot-jsonb', 'lexical-plural-ranking'],
  };
  private pool: Pool;
  private initialized = false;
  private readonly options: PostgresOptions;
  private opened = false;
  constructor(options: PostgresOptions) {
    super();
    if (
      typeof options.connectionString !== 'string' ||
      !options.connectionString ||
      typeof options.storeId !== 'string' ||
      !/^[a-zA-Z0-9_./-]{1,200}$/.test(options.storeId) ||
      !Number.isSafeInteger(options.timeoutMs ?? 10000) ||
      (options.timeoutMs ?? 10000) < 1 ||
      (options.timeoutMs ?? 10000) > 120000
    )
      throw new ValidationFailedError('Invalid PostgreSQL storage configuration');
    this.options = options;
    this.pool = this.makePool();
  }
  private makePool(): Pool {
    const options = this.options;
    const pool = new Pool({
      connectionString: options.connectionString,
      max: 4,
      connectionTimeoutMillis: options.timeoutMs ?? 10000,
      statement_timeout: options.timeoutMs ?? 10000,
    });
    // Avoid an unhandled idle-client error; the next operation reports availability.
    pool.on('error', () => {});
    return pool;
  }
  async open(): Promise<void> {
    if (this.opened) return;
    try {
      const schema = await this.pool.connect();
      try {
      await schema.query('BEGIN');
      // CREATE IF NOT EXISTS alone does not serialize concurrent catalog creation.
      await schema.query("SELECT pg_advisory_xact_lock(741119023)");
      if (this.options.initialize && !this.initialized) {
        await schema.query(`CREATE TABLE IF NOT EXISTS memorykit_stores (
          store_id text PRIMARY KEY, payload jsonb NOT NULL)`);
        const result = await schema.query(
          'INSERT INTO memorykit_stores(store_id,payload) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING store_id',
          [this.options.storeId, JSON.stringify({ state: emptyState(), rows: [] })]
        );
        if (result.rowCount !== 1)
          throw new StoreUnavailableError('PostgreSQL store already exists', {
            reason: 'already_a_store',
          });
      }
      await schema.query(`CREATE TABLE IF NOT EXISTS memorykit_search_rows_v1 (
        store_id text NOT NULL REFERENCES memorykit_stores(store_id) ON DELETE CASCADE,
        id text NOT NULL, namespace text NOT NULL, state text NOT NULL, kind text NOT NULL,
        terms text[] NOT NULL, supersedes text[] NOT NULL, record jsonb NOT NULL,
        PRIMARY KEY(store_id,id))`);
      await schema.query('CREATE INDEX IF NOT EXISTS memorykit_search_terms_v1 ON memorykit_search_rows_v1 USING gin(terms)');
      await schema.query('CREATE INDEX IF NOT EXISTS memorykit_search_links_v1 ON memorykit_search_rows_v1 USING gin(supersedes)');
      await schema.query('CREATE INDEX IF NOT EXISTS memorykit_search_scope_v1 ON memorykit_search_rows_v1(store_id,namespace,state)');
      await schema.query('COMMIT');
      if (this.options.initialize) this.initialized = true;
      } catch (error) {
        await schema.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally { schema.release(); }
      this.opened = true;
      // Upgrade under the existing store write lock. Derived rows and marker commit together.
      await this.use(true, () => undefined);
    } catch (e) {
      this.opened = false;
      await this.pool.end();
      this.pool = this.makePool();
      throw this.problem(e);
    }
  }
  async close(): Promise<void> {
    if (!this.opened) return;
    this.opened = false;
    await this.pool.end();
    this.pool = this.makePool();
  }
  private problem(e: unknown): Error {
    if (e instanceof MemoryKitError) return e;
    const code = (e as { code?: string })?.code;
    if (code === '55P03' || code === '57014')
      return new StoreBusyError('PostgreSQL operation timed out');
    return new StoreUnavailableError('PostgreSQL storage is unavailable', {
      reason: 'database_unavailable',
    });
  }
  private async syncRows(client: PoolClient, rows: RecordRow[]): Promise<void> {
    await client.query('DELETE FROM memorykit_search_rows_v1 WHERE store_id=$1 AND NOT(id=ANY($2::text[]))',
      [this.options.storeId, rows.map((r) => r.id)]);
    const indexed = rows.map((record) => ({
      id: record.id, namespace: record.namespace, state: record.state, kind: record.kind,
      terms: indexedTerms(record), supersedes: record.links.filter((l) => l.type === 'supersedes').map((l) => l.target), record,
    }));
    await client.query(`INSERT INTO memorykit_search_rows_v1(store_id,id,namespace,state,kind,terms,supersedes,record)
      SELECT $1,id,namespace,state,kind,terms,supersedes,record FROM jsonb_to_recordset($2::jsonb)
      AS x(id text,namespace text,state text,kind text,terms text[],supersedes text[],record jsonb)
      ON CONFLICT(store_id,id) DO UPDATE SET namespace=EXCLUDED.namespace,state=EXCLUDED.state,
      kind=EXCLUDED.kind,terms=EXCLUDED.terms,supersedes=EXCLUDED.supersedes,record=EXCLUDED.record
      WHERE memorykit_search_rows_v1.record IS DISTINCT FROM EXCLUDED.record`,
      [this.options.storeId, JSON.stringify(indexed)]);
  }
  protected async readRows<T>(selection: RowSelection, fn: (rows: RecordRow[]) => T): Promise<T> {
    if (!this.opened) throw new StoreUnavailableError('Store is closed', { reason: 'closed' });
    const client = await this.pool.connect().catch((e) => { throw this.problem(e); });
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      const marker = await client.query("SELECT payload->>'searchVersion' AS version FROM memorykit_stores WHERE store_id=$1", [this.options.storeId]);
      if (marker.rows[0]?.version !== '1') {
        // An older writer drops the marker. Never read stale derived rows.
        const result = await client.query('SELECT payload FROM memorykit_stores WHERE store_id=$1', [this.options.storeId]);
        if (!result.rows[0]) throw new StoreUnavailableError('PostgreSQL store does not exist');
        const { state, rows } = result.rows[0].payload;
        if (state?.version !== 1 || !Array.isArray(rows) || !Array.isArray(state.operations) || !Array.isArray(state.outbox))
          throw new StoreUnavailableError('Invalid PostgreSQL store state', { reason: 'integrity_failed' });
        const value = fn(rows);
        await client.query('COMMIT');
        return structuredClone(value);
      }
      const values: unknown[] = [this.options.storeId];
      const bind = (v: unknown) => { values.push(v); return '$' + values.length; };
      const terms = selectionTerms(selection);
      const predicate = rowPredicate(selection, bind) + (terms.length
        ? ` AND terms ${selection.any ? '&&' : '@>'} ${bind(terms)}::text[]` : '');
      const selected = selection.supersededIds
        ? `SELECT id FROM memorykit_search_rows_v1 WHERE 1=0`
        : `SELECT id FROM memorykit_search_rows_v1 WHERE store_id=$1 AND ${predicate}`;
      const targets = selection.supersededIds ? bind(selection.supersededIds) + '::text[]' : 'ARRAY(SELECT id FROM selected)';
      const result = await client.query(`WITH selected AS (${selected})
        SELECT record FROM memorykit_search_rows_v1 WHERE store_id=$1 AND
        (id IN (SELECT id FROM selected) OR supersedes && ${targets})`, values);
      const value = fn(result.rows.map((r) => r.record as RecordRow));
      await client.query('COMMIT');
      return structuredClone(value);
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw this.problem(e);
    } finally { client.release(); }
  }
  protected async use<T>(
    change: boolean,
    fn: (state: State, rows: RecordRow[]) => T | Promise<T>
  ): Promise<T> {
    if (!this.opened) throw new StoreUnavailableError('Store is closed', { reason: 'closed' });
    const client = await this.pool.connect().catch((e) => {
      throw this.problem(e);
    });
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('lock_timeout',$1,true)", [
        String(this.options.timeoutMs ?? 10000),
      ]);
      const result = await client.query(
        'SELECT payload FROM memorykit_stores WHERE store_id=$1' + (change ? ' FOR UPDATE' : ''),
        [this.options.storeId]
      );
      if (result.rowCount !== 1)
        throw new StoreUnavailableError('PostgreSQL store does not exist', {
          reason: 'not_a_store',
        });
      const { state, rows } = result.rows[0].payload as { state: State; rows: RecordRow[] };
      const before = JSON.stringify(rows);
      if (
        state?.version !== 1 ||
        !Array.isArray(rows) ||
        !Array.isArray(state.operations) ||
        !Array.isArray(state.outbox)
      )
        throw new StoreUnavailableError('Invalid PostgreSQL store state', {
          reason: 'integrity_failed',
        });
      const value = await fn(state, rows);
      if (change) {
        if (result.rows[0].payload.searchVersion !== 1 || before !== JSON.stringify(rows))
          await this.syncRows(client, rows);
        await client.query('UPDATE memorykit_stores SET payload=$2 WHERE store_id=$1', [
          this.options.storeId,
          JSON.stringify({ state, rows, searchVersion: 1 }),
        ]);
      }
      await client.query('COMMIT');
      return structuredClone(value);
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw this.problem(e);
    } finally {
      client.release();
    }
  }
}

export async function createStorage({ options, initialize }: StoragePluginContext) {
  if (
    Object.keys(options).some(
      (k) => !['connectionStringEnv', 'storeId', 'timeoutMs'].includes(k)
    ) ||
    (options.connectionStringEnv !== undefined &&
      (typeof options.connectionStringEnv !== 'string' ||
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(options.connectionStringEnv))) ||
    typeof options.storeId !== 'string' ||
    (options.timeoutMs !== undefined && typeof options.timeoutMs !== 'number')
  )
    throw new ValidationFailedError('Invalid PostgreSQL plugin options');
  const name = (options.connectionStringEnv as string | undefined) ?? 'MEMORYKIT_POSTGRES_URL';
  const connectionString = process.env[name];
  if (!connectionString)
    throw new StoreUnavailableError('PostgreSQL connection environment variable is missing', {
      reason: 'missing_connection',
    });
  const storage = new PostgresStorage({
    connectionString,
    storeId: options.storeId,
    initialize,
    timeoutMs: options.timeoutMs as number | undefined,
  });
  return { storage, tokens: storage };
}
