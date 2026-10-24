import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_LIMITS,
  ForbiddenError,
  InvalidTransitionError,
  LimitExceededError,
  NotFoundError,
  StoreBusyError,
  ValidationFailedError,
  canonicalJson,
  isMemoryId,
  matchesPattern,
  newMemoryId,
  nextState,
  parseNamespace,
  toProblem,
  validateCreate,
} from '../src/model/index.ts';
import { EMBEDDED_PRINCIPAL, authorize, permittedPatterns } from '../src/access/index.ts';

describe('ids', () => {
  it('makes 26-character ULIDs that sort by time', () => {
    const early = newMemoryId(1_000);
    const late = newMemoryId(2_000);
    assert.equal(early.length, 26);
    assert.ok(isMemoryId(early));
    assert.ok(early < late);
    assert.notEqual(newMemoryId(), newMemoryId());
  });

  it('rejects malformed ids', () => {
    assert.equal(isMemoryId('01ARZ3NDEKTSV4RRFFQ69G5FAV'), true);
    assert.equal(isMemoryId('01arz3ndektsv4rrffq69g5fav'), false);
    assert.equal(isMemoryId('81ARZ3NDEKTSV4RRFFQ69G5FAV'), false);
    assert.equal(isMemoryId('01ARZ3NDEKTSV4RRFFQ69G5FA'), false);
    assert.equal(isMemoryId(42), false);
  });
});

describe('namespaces', () => {
  it('accepts lower-case segments and rejects anything else', () => {
    assert.equal(parseNamespace('demo'), 'demo');
    assert.equal(parseNamespace('team/a_b/notes-1.x'), 'team/a_b/notes-1.x');
    for (const bad of [
      'Demo',
      '',
      'a//b',
      '/a',
      'a/',
      '-a',
      'a/'.repeat(8) + 'a',
      'x'.repeat(65),
    ]) {
      assert.throws(() => parseNamespace(bad), ValidationFailedError, bad);
    }
  });

  it('matches exact, subtree and wildcard patterns', () => {
    assert.ok(matchesPattern('*', 'anything/here'));
    assert.ok(matchesPattern('team/a', 'team/a'));
    assert.ok(!matchesPattern('team/a', 'team/a/notes'));
    assert.ok(matchesPattern('team/a/*', 'team/a'));
    assert.ok(matchesPattern('team/a/*', 'team/a/notes'));
    assert.ok(!matchesPattern('team/a/*', 'team/ab'));
  });
});

describe('validateCreate', () => {
  const base = { namespace: 'demo', kind: 'note', content: 'hello' };

  it('fills defaults', () => {
    const result = validateCreate(base, DEFAULT_LIMITS);
    assert.deepEqual(result, {
      ...base,
      key: null,
      contentType: 'text/plain',
      metadata: {},
      links: [],
      provenance: { evidence: [] },
    });
  });

  it('rejects bad structure with ValidationFailed', () => {
    const cases: unknown[] = [
      { ...base, namespace: 'Demo' },
      { ...base, contentType: 'application/json', content: '{bad' },
      { ...base, contentType: 'text/html' },
      { ...base, kind: '' },
      { ...base, metadata: [] },
      { ...base, metadata: { when: new Date() } },
      { ...base, links: [{ type: 'likes', target: newMemoryId() }] },
      { ...base, links: [{ type: 'supersedes', target: 'nope' }] },
      { ...base, extra: true },
      { ...base, provenance: { evidence: [{ ref: '' }] } },
    ];
    for (const input of cases)
      assert.throws(() => validateCreate(input, DEFAULT_LIMITS), ValidationFailedError);
  });

  it('rejects oversize input with LimitExceeded and no values in details', () => {
    const big = 'x'.repeat(DEFAULT_LIMITS.maxContentBytes + 1);
    assert.throws(
      () => validateCreate({ ...base, content: big }, DEFAULT_LIMITS),
      (error: unknown) =>
        error instanceof LimitExceededError &&
        error.details.field === 'content' &&
        !JSON.stringify(error.details).includes('xxx')
    );
    const links = Array.from({ length: DEFAULT_LIMITS.maxLinks + 1 }, () => ({
      type: 'related_to',
      target: newMemoryId(),
    }));
    assert.throws(() => validateCreate({ ...base, links }, DEFAULT_LIMITS), LimitExceededError);
  });

  it('accepts extension link types', () => {
    const target = newMemoryId();
    const result = validateCreate(
      { ...base, links: [{ type: 'x-cites', target }] },
      DEFAULT_LIMITS
    );
    assert.deepEqual(result.links, [{ type: 'x-cites', target }]);
  });
});

describe('errors', () => {
  it('map to problem documents', () => {
    assert.deepEqual(toProblem(new NotFoundError('Memory not found', { id: 'x' })), {
      type: 'urn:memorykit:error:NotFound',
      title: 'Memory not found',
      status: 404,
      code: 'NotFound',
      retryable: false,
      details: { id: 'x' },
    });
    assert.equal(toProblem(new StoreBusyError('busy')).retryable, true);
    const internal = toProblem(new Error('secret content'));
    assert.equal(internal.code, 'Internal');
    assert.ok(!internal.title.includes('secret'));
  });
});

describe('canonicalJson', () => {
  it('sorts keys at every level', () => {
    assert.equal(
      canonicalJson({ b: 1, a: { d: [{ f: 1, e: 2 }], c: null } }),
      '{"a":{"c":null,"d":[{"e":2,"f":1}]},"b":1}'
    );
  });
});

describe('access', () => {
  it('grants the embedded principal everything on *', () => {
    assert.deepEqual(permittedPatterns(EMBEDDED_PRINCIPAL, 'purge'), ['*']);
    assert.deepEqual(
      permittedPatterns(
        { id: 'p', profile: 'local', grants: [{ pattern: 'a/*', permissions: ['write'] }] },
        'read'
      ),
      []
    );
  });

  it('authorize throws Forbidden outside the grants', () => {
    const p = {
      id: 'p',
      profile: 'local' as const,
      grants: [{ pattern: 'team/*' as const, permissions: ['write' as const] }],
    };
    authorize(p, 'write', parseNamespace('team/notes'));
    authorize(EMBEDDED_PRINCIPAL, 'purge', parseNamespace('any'));
    assert.throws(
      () => authorize(p, 'write', parseNamespace('other')),
      (error: unknown) =>
        error instanceof ForbiddenError &&
        error.details.namespace === 'other' &&
        error.details.permission === 'write'
    );
    assert.throws(() => authorize(p, 'read', parseNamespace('team/notes')), ForbiddenError);
  });
});

describe('lifecycle', () => {
  it('follows the transition table and refuses everything else', () => {
    assert.equal(nextState('create', null, null), 'active');
    for (const state of ['active', 'superseded', 'archived'] as const) {
      assert.equal(nextState('update', state, null), state);
      assert.equal(nextState('tombstone', state, null), 'tombstoned');
    }
    assert.equal(nextState('archive', 'active', null), 'archived');
    assert.equal(nextState('supersede', 'archived', null), 'superseded');
    assert.equal(nextState('restore', 'archived', null), 'active');
    assert.equal(nextState('restore', 'tombstoned', 'superseded'), 'superseded');
    for (const [op, from] of [
      ['create', 'active'],
      ['update', 'tombstoned'],
      ['archive', 'archived'],
      ['supersede', 'tombstoned'],
      ['restore', 'active'],
      ['purge', 'active'],
    ] as const) {
      assert.throws(
        () => nextState(op, from, null),
        (error: unknown) =>
          error instanceof InvalidTransitionError &&
          error.details.operation === op &&
          error.details.state === from
      );
    }
  });
});
