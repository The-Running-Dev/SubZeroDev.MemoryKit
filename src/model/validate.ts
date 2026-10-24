// Structural and limit checks for service inputs. Structure is checked before limits,
// and nothing here reaches a provider.

import { LimitExceededError, ValidationFailedError } from './errors.ts';
import { isMemoryId } from './ids.ts';
import { isJsonValue, isPlainObject } from './json.ts';
import { parseNamespace } from './namespace.ts';
import {
  CONTENT_TYPES,
  CORE_LINK_TYPES,
  type ContentType,
  type JsonValue,
  type Limits,
  type Link,
  type LinkType,
  type MemoryId,
  type Namespace,
  type Provenance,
} from './types.ts';

export const MAX_KEY_LENGTH = 512;
export const MAX_KIND_LENGTH = 128;
export const MAX_OPERATION_ID_LENGTH = 128;

const CONTROL = /\p{Cc}/u;
// A lone surrogate cannot be encoded as UTF-8, so it would not round-trip through storage.
const LONE_SURROGATE = /\p{Cs}/u;
const LINK_EXTENSION = /^x-[a-z0-9][a-z0-9._-]{0,63}$/;
const OPERATION_ID = /^[A-Za-z0-9._:-]+$/;

export interface NormalizedUpdate {
  id: MemoryId;
  expectedRevision: number;
  changes: Partial<
    Pick<NormalizedCreate, 'kind' | 'content' | 'contentType' | 'metadata' | 'links' | 'provenance'>
  >;
}

export interface NormalizedCreate {
  namespace: Namespace;
  key: string | null;
  kind: string;
  content: string;
  contentType: ContentType;
  metadata: Record<string, JsonValue>;
  links: Link[];
  provenance: Provenance;
}

function invalid(field: string, reason: string): never {
  throw new ValidationFailedError(`Invalid ${field}: ${reason}`, { field, reason });
}

function onlyFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  prefix: string
): void {
  for (const field of Object.keys(value)) {
    if (!allowed.includes(field)) invalid(prefix + field, 'unknown_field');
  }
}

function label(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0) invalid(field, 'required');
  if (value.length > maxLength) invalid(field, 'too_long');
  if (CONTROL.test(value)) invalid(field, 'control_character');
  return value;
}

// Every string in the input, keys included, must be well-formed Unicode.
function requireWellFormed(value: unknown, field: string): void {
  if (typeof value === 'string') {
    if (LONE_SURROGATE.test(value)) invalid(field, 'ill_formed_unicode');
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => requireWellFormed(item, `${field}[${index}]`));
  } else if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      const path = field === '' ? key : `${field}.${key}`;
      if (LONE_SURROGATE.test(key)) invalid(path, 'ill_formed_unicode');
      requireWellFormed(item, path);
    }
  }
}

function bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function checkLimit(field: string, actual: number, limit: number): void {
  if (actual > limit) {
    throw new LimitExceededError(`${field} exceeds its limit`, { field, limit, actual });
  }
}

export function validateOperationId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !OPERATION_ID.test(value)) invalid('operationId', 'malformed');
  if (value.length > MAX_OPERATION_ID_LENGTH) invalid('operationId', 'too_long');
  return value;
}

export function validateMemoryId(value: unknown, field = 'id'): string {
  if (!isMemoryId(value)) invalid(field, 'malformed');
  return value;
}

function validateContentType(value: unknown): ContentType {
  if (value === undefined) return 'text/plain';
  if (!CONTENT_TYPES.includes(value as ContentType)) invalid('contentType', 'unsupported');
  return value as ContentType;
}

function validateMetadata(value: unknown): Record<string, JsonValue> {
  if (value === undefined) return {};
  if (!isPlainObject(value) || !isJsonValue(value)) invalid('metadata', 'not_a_json_object');
  return value as Record<string, JsonValue>;
}

function validateLinks(value: unknown): Link[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) invalid('links', 'not_an_array');
  return value.map((link: unknown, index) => {
    const field = `links[${index}]`;
    if (!isPlainObject(link)) invalid(field, 'not_an_object');
    onlyFields(link, ['type', 'target'], field + '.');
    const type = link.type;
    if (
      typeof type !== 'string' ||
      !(CORE_LINK_TYPES.includes(type as never) || LINK_EXTENSION.test(type))
    ) {
      invalid(field + '.type', 'unsupported');
    }
    return { type: type as LinkType, target: validateMemoryId(link.target, field + '.target') };
  });
}

function validateProvenance(value: unknown): Provenance {
  if (value === undefined) return { evidence: [] };
  if (!isPlainObject(value)) invalid('provenance', 'not_an_object');
  onlyFields(value, ['origin', 'reason', 'evidence'], 'provenance.');
  const provenance: Provenance = { evidence: [] };
  if (value.origin !== undefined) {
    const origin = value.origin;
    if (!isPlainObject(origin)) invalid('provenance.origin', 'not_an_object');
    onlyFields(origin, ['kind', 'name', 'version'], 'provenance.origin.');
    provenance.origin = {
      kind: label(origin.kind, 'provenance.origin.kind', MAX_KIND_LENGTH),
      name: label(origin.name, 'provenance.origin.name', MAX_KEY_LENGTH),
    };
    if (origin.version !== undefined) {
      provenance.origin.version = label(
        origin.version,
        'provenance.origin.version',
        MAX_KIND_LENGTH
      );
    }
  }
  if (value.reason !== undefined) {
    if (typeof value.reason !== 'string') invalid('provenance.reason', 'not_a_string');
    provenance.reason = value.reason;
  }
  if (value.evidence !== undefined) {
    if (!Array.isArray(value.evidence)) invalid('provenance.evidence', 'not_an_array');
    provenance.evidence = value.evidence.map((item: unknown, index) => {
      const field = `provenance.evidence[${index}]`;
      if (!isPlainObject(item)) invalid(field, 'not_an_object');
      onlyFields(item, ['ref', 'note'], field + '.');
      const evidence: Provenance['evidence'][number] = {
        ref: label(item.ref, field + '.ref', MAX_KEY_LENGTH),
      };
      if (item.note !== undefined) {
        if (typeof item.note !== 'string') invalid(field + '.note', 'not_a_string');
        evidence.note = item.note;
      }
      return evidence;
    });
  }
  return provenance;
}

// Checked again after an update merges its changes, since either side may change.
export function requireContentMatchesType(content: string, contentType: ContentType): void {
  if (contentType !== 'application/json') return;
  try {
    JSON.parse(content);
  } catch {
    invalid('content', 'invalid_json');
  }
}

export function validateRevision(value: unknown, field = 'expectedRevision'): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    invalid(field, 'not_a_revision');
  }
  return value;
}

export function validateCreate(input: unknown, limits: Limits): NormalizedCreate {
  if (!isPlainObject(input)) invalid('input', 'not_an_object');
  onlyFields(
    input,
    ['namespace', 'key', 'kind', 'content', 'contentType', 'metadata', 'links', 'provenance'],
    ''
  );
  requireWellFormed(input, '');
  if (typeof input.namespace !== 'string') invalid('namespace', 'required');
  const namespace = parseNamespace(input.namespace);
  const key = input.key === undefined ? null : label(input.key, 'key', MAX_KEY_LENGTH);
  const kind = label(input.kind, 'kind', MAX_KIND_LENGTH);
  if (typeof input.content !== 'string') invalid('content', 'required');
  const content = input.content;
  const contentType = validateContentType(input.contentType);
  requireContentMatchesType(content, contentType);
  const metadata = validateMetadata(input.metadata);
  const links = validateLinks(input.links);
  const provenance = validateProvenance(input.provenance);

  checkLimit('content', bytes(content), limits.maxContentBytes);
  checkLimit('metadata', bytes(JSON.stringify(metadata)), limits.maxMetadataBytes);
  checkLimit('provenance', bytes(JSON.stringify(provenance)), limits.maxMetadataBytes);
  checkLimit('links', links.length, limits.maxLinks);

  return { namespace, key, kind, content, contentType, metadata, links, provenance };
}

// Omitted fields keep their value; links and metadata are replaced whole.
export function validateUpdate(input: unknown, limits: Limits): NormalizedUpdate {
  if (!isPlainObject(input)) invalid('input', 'not_an_object');
  onlyFields(
    input,
    ['id', 'expectedRevision', 'kind', 'content', 'contentType', 'metadata', 'links', 'provenance'],
    ''
  );
  requireWellFormed(input, '');
  const id = validateMemoryId(input.id);
  const expectedRevision = validateRevision(input.expectedRevision);
  const changes: NormalizedUpdate['changes'] = {};
  if (input.kind !== undefined) changes.kind = label(input.kind, 'kind', MAX_KIND_LENGTH);
  if (input.content !== undefined) {
    if (typeof input.content !== 'string') invalid('content', 'not_a_string');
    changes.content = input.content;
  }
  if (input.contentType !== undefined) changes.contentType = validateContentType(input.contentType);
  if (input.metadata !== undefined) changes.metadata = validateMetadata(input.metadata);
  if (input.links !== undefined) changes.links = validateLinks(input.links);
  if (input.provenance !== undefined) changes.provenance = validateProvenance(input.provenance);

  // Limits after shape, as in validateCreate, so a malformed field is reported first.
  if (changes.content !== undefined) {
    checkLimit('content', bytes(changes.content), limits.maxContentBytes);
  }
  if (changes.metadata !== undefined) {
    checkLimit('metadata', bytes(JSON.stringify(changes.metadata)), limits.maxMetadataBytes);
  }
  if (changes.provenance !== undefined) {
    checkLimit('provenance', bytes(JSON.stringify(changes.provenance)), limits.maxMetadataBytes);
  }
  if (changes.links !== undefined) checkLimit('links', changes.links.length, limits.maxLinks);
  return { id, expectedRevision, changes };
}
