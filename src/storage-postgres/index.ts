// Optional external plugin. Loading the core SDK never imports pg or opens a socket.
import { Pool } from 'pg';
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

/** Transactional JSONB state, serialized per logical store. Intended for modest stores. */
export class PostgresStorage extends StateStorage {
  readonly descriptor = {
    id: 'storage-postgres',
    version: '0.1.0',
    contractVersions: [1],
    capabilities: ['search.lexical', 'retrieve.lexical', 'purge.current'],
    limitations: ['linear-search', 'serialized-store-writes', 'snapshot-jsonb'],
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
      if (this.options.initialize && !this.initialized) {
        await this.pool.query(`CREATE TABLE IF NOT EXISTS memorykit_stores (
          store_id text PRIMARY KEY, payload jsonb NOT NULL)`);
        const result = await this.pool.query(
          'INSERT INTO memorykit_stores(store_id,payload) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING store_id',
          [this.options.storeId, JSON.stringify({ state: emptyState(), rows: [] })]
        );
        if (result.rowCount !== 1)
          throw new StoreUnavailableError('PostgreSQL store already exists', {
            reason: 'already_a_store',
          });
        this.initialized = true;
      }
      this.opened = true;
      await this.use(false, () => undefined);
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
      if (change)
        await client.query('UPDATE memorykit_stores SET payload=$2 WHERE store_id=$1', [
          this.options.storeId,
          JSON.stringify({ state, rows }),
        ]);
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
