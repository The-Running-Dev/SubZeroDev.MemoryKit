// Record and value types shared by every module (20-contract.md, model).

export type MemoryId = string; // ULID, 26 chars, Crockford base32
export type Namespace = string; // 1-8 segments of [a-z0-9][a-z0-9._-]{0,63}, joined by "/"
export type NamespacePattern = string; // "a/b" exact | "a/b/*" subtree | "*"
export type MemoryState = 'active' | 'superseded' | 'archived' | 'tombstoned';
export type ContentType = 'text/plain' | 'text/markdown' | 'application/json';
export type CoreLinkType =
  | 'supersedes'
  | 'derived_from'
  | 'contradicts'
  | 'validated_by'
  | 'depends_on'
  | 'related_to'
  | 'belongs_to';
export type LinkType = CoreLinkType | `x-${string}`;
export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type Operation =
  'create' | 'update' | 'archive' | 'supersede' | 'tombstone' | 'restore' | 'purge';
export type Permission = 'read' | 'write' | 'tombstone' | 'history' | 'purge' | 'admin';

export interface Link {
  type: LinkType;
  target: MemoryId;
}
export interface Evidence {
  ref: string;
  note?: string;
}
export interface Provenance {
  origin?: { kind: string; name: string; version?: string };
  reason?: string;
  evidence: Evidence[];
}

export interface MemoryRecord {
  id: MemoryId;
  namespace: Namespace;
  key: string | null;
  kind: string;
  content: string;
  contentType: ContentType;
  metadata: Record<string, JsonValue>;
  links: Link[];
  state: MemoryState;
  priorState: MemoryState | null;
  revision: number;
  provenance: Provenance;
  actor: string;
  createdAt: string; // ISO 8601 UTC
  updatedAt: string;
  supersededBy: MemoryId[]; // derived
}

export interface Limits {
  maxContentBytes: number;
  maxMetadataBytes: number;
  maxLinks: number;
  maxPageSize: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxContentBytes: 262144,
  maxMetadataBytes: 16384,
  maxLinks: 64,
  maxPageSize: 100,
};

export const CONTENT_TYPES: readonly ContentType[] = [
  'text/plain',
  'text/markdown',
  'application/json',
];
export const CORE_LINK_TYPES: readonly CoreLinkType[] = [
  'supersedes',
  'derived_from',
  'contradicts',
  'validated_by',
  'depends_on',
  'related_to',
  'belongs_to',
];
