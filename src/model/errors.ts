// Typed errors. Every error carries a code, whether it is retryable, and details that never
// hold content or metadata values (invariant 18).

import type { JsonValue } from './types.ts';

export type ErrorCode =
  | 'ValidationFailed'
  | 'LimitExceeded'
  | 'Unauthenticated'
  | 'AuthenticationUnavailable'
  | 'Forbidden'
  | 'NotFound'
  | 'AlreadyExists'
  | 'RevisionConflict'
  | 'InvalidTransition'
  | 'IdempotencyMismatch'
  | 'HistoryNotRetained'
  | 'HistoryUnavailable'
  | 'Unsupported'
  | 'UnsupportedContractVersion'
  | 'StoreBusy'
  | 'StoreUnavailable'
  | 'StoreVersionTooNew'
  | 'Internal';

export type ErrorDetails = Record<string, JsonValue>;

export abstract class MemoryKitError extends Error {
  abstract readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details: ErrorDetails;

  constructor(message: string, details: ErrorDetails = {}, retryable = false) {
    super(message);
    this.name = new.target.name;
    this.details = details;
    this.retryable = retryable;
  }
}

export class ValidationFailedError extends MemoryKitError {
  readonly code = 'ValidationFailed' as const;
}
export class LimitExceededError extends MemoryKitError {
  readonly code = 'LimitExceeded' as const;
}
export class UnauthenticatedError extends MemoryKitError {
  readonly code = 'Unauthenticated' as const;
}
export class AuthenticationUnavailableError extends MemoryKitError {
  readonly code = 'AuthenticationUnavailable' as const;
  constructor(message: string, details: ErrorDetails = {}) {
    super(message, details, true);
  }
}
export class ForbiddenError extends MemoryKitError {
  readonly code = 'Forbidden' as const;
}
export class NotFoundError extends MemoryKitError {
  readonly code = 'NotFound' as const;
}
export class AlreadyExistsError extends MemoryKitError {
  readonly code = 'AlreadyExists' as const;
}
export class RevisionConflictError extends MemoryKitError {
  readonly code = 'RevisionConflict' as const;
}
export class InvalidTransitionError extends MemoryKitError {
  readonly code = 'InvalidTransition' as const;
}
export class IdempotencyMismatchError extends MemoryKitError {
  readonly code = 'IdempotencyMismatch' as const;
}
export class HistoryNotRetainedError extends MemoryKitError {
  readonly code = 'HistoryNotRetained' as const;
}
export class HistoryUnavailableError extends MemoryKitError {
  readonly code = 'HistoryUnavailable' as const;
  constructor(message: string, details: ErrorDetails = {}) {
    super(message, details, true);
  }
}
export class UnsupportedError extends MemoryKitError {
  readonly code = 'Unsupported' as const;
}
export class UnsupportedContractVersionError extends MemoryKitError {
  readonly code = 'UnsupportedContractVersion' as const;
}
export class StoreBusyError extends MemoryKitError {
  readonly code = 'StoreBusy' as const;
  constructor(message: string, details: ErrorDetails = {}) {
    super(message, details, true);
  }
}
export class StoreUnavailableError extends MemoryKitError {
  readonly code = 'StoreUnavailable' as const;
}
export class StoreVersionTooNewError extends MemoryKitError {
  readonly code = 'StoreVersionTooNew' as const;
}
export class InternalError extends MemoryKitError {
  readonly code = 'Internal' as const;
}

const HTTP_STATUS: Record<ErrorCode, number> = {
  ValidationFailed: 400,
  LimitExceeded: 413,
  Unauthenticated: 401,
  AuthenticationUnavailable: 503,
  Forbidden: 403,
  NotFound: 404,
  AlreadyExists: 409,
  RevisionConflict: 409,
  InvalidTransition: 409,
  IdempotencyMismatch: 422,
  HistoryNotRetained: 404,
  HistoryUnavailable: 503,
  Unsupported: 501,
  UnsupportedContractVersion: 500,
  StoreBusy: 503,
  StoreUnavailable: 503,
  StoreVersionTooNew: 500,
  Internal: 500,
};

export interface Problem {
  type: string;
  title: string;
  status: number;
  code: ErrorCode;
  retryable: boolean;
  details: ErrorDetails;
}

// RFC 9457 problem body for an error. Anything that is not a MemoryKitError is Internal,
// and its message is not exposed, since it may carry values.
export function toProblem(error: unknown): Problem {
  const known = error instanceof MemoryKitError ? error : new InternalError('Internal error');
  return {
    type: 'urn:memorykit:error:' + known.code,
    title: known.message,
    status: HTTP_STATUS[known.code],
    code: known.code,
    retryable: known.retryable,
    details: known.details,
  };
}
