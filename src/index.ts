// Public entry point.

export * from './model/index.ts';
export * from './access/index.ts';
export * from './contracts/index.ts';
export * from './service/index.ts';
export {
  connect,
  initStore,
  openService,
  openStore,
  openTokenStore,
  type ConnectOptions,
  type OpenService,
  type StoreConfig,
  storeExists,
  type StorageConfig,
  type StoragePlugin,
  type StoragePluginContext,
} from './sdk/index.ts';
export {
  LocalTokenAuthenticator,
  OidcAuthenticator,
  bearerToken,
  type Authenticator,
  type OidcOptions,
} from './authn/index.ts';
export { handle, problemResponse, type HttpRequest, type HttpResponse } from './http/index.ts';
export { isLoopback, serve, type ServeOptions } from './server/index.ts';
export { SqliteStorage, type SqliteStorageOptions } from './storage-sqlite/index.ts';
export { MarkdownStorage } from './storage-markdown/index.ts';
export { MemoryHistory } from './history-memory/index.ts';
export {
  capture,
  planCapture,
  context,
  accept,
  type Scope,
  type CaptureSource,
  type Observation,
  type CaptureInput,
  type CaptureResult,
  type Distiller,
  type EmbeddingProvider,
  type EmbeddingIndex,
  type RecallPassage,
  type RecallRequest,
  type RecallSelection,
  type RecallSelector,
  type ContextInput,
  type ContextItem,
  type ContextResult,
} from './workflow/index.ts';
export {
  planClaudeMemImport,
  importClaudeMem,
  reconcileClaudeMem,
  type ClaudeMemImportOptions,
  type ClaudeMemImportPlan,
} from './workflow/import.ts';

export {
  gitSourceStatus,
  planGitSource,
  syncGitSource,
  validateGitSource,
  type GitSourceConfig,
  type GitSourcePlan,
  type GitSourceConflict,
  type GitSourceStatus,
  type GitSourceSyncOptions,
  type GitSourceSyncResult,
  type GitSourceSyncState,
  type GitSourceSkip,
  type NamespaceMapping,
} from './workflow/git-source.ts';

export { exportStore, importStore, type PortableArchive } from './sdk/portable.ts';
export {
  reviewQueue,
  reviewMemory,
  type ReviewItem,
  type ReviewInput,
  type ReviewQueueInput,
} from './workflow/review.ts';

export { CachedRecallSelector, type RecallCache } from './workflow/recall-cache.ts';
export { browse, type BrowseInput, type BrowseItem, type BrowseResult } from './workflow/browse.ts';
