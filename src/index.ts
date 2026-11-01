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
  type ClaudeMemImportOptions,
  type ClaudeMemImportPlan,
} from './workflow/import.ts';
