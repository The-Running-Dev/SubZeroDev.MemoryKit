// The lifecycle transition table (10-design.md). Any other transition is InvalidTransition.

import { InvalidTransitionError } from './errors.ts';
import type { MemoryState, Operation } from './types.ts';

export function nextState(
  op: Operation,
  from: MemoryState | null,
  prior: MemoryState | null
): MemoryState {
  const to = transition(op, from, prior);
  if (to === null) {
    throw new InvalidTransitionError(`${op} is not allowed from ${from ?? 'nothing'}`, {
      operation: op,
      state: from,
    });
  }
  return to;
}

function transition(
  op: Operation,
  from: MemoryState | null,
  prior: MemoryState | null
): MemoryState | null {
  switch (op) {
    case 'create':
      return from === null ? 'active' : null;
    case 'update':
      return from === 'active' || from === 'superseded' || from === 'archived' ? from : null;
    case 'archive':
      return from === 'active' ? 'archived' : null;
    case 'supersede':
      return from === 'active' || from === 'archived' ? 'superseded' : null;
    case 'tombstone':
      return from === 'active' || from === 'superseded' || from === 'archived'
        ? 'tombstoned'
        : null;
    case 'restore':
      if (from === 'archived') return 'active';
      return from === 'tombstoned' ? prior : null;
    case 'purge':
      return null; // a purge removes the row; it has no next state
  }
}
