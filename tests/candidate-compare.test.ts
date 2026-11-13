import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compareCandidates, summarizeComparison } from '../eval/retrieval/candidates.ts';

describe('S31 candidate comparison', () => {
  it('counts needed records a source loses against expansion (S31.2)', () => {
    const r = compareCandidates({
      id: 'a',
      expected: ['x@1', 'y@1'],
      expansion: ['x@1', 'y@1', 'f@1'],
      source: ['x@1', 'z@1', 'f@1'],
    });
    assert.deepEqual(r.foundByExpansion, ['x@1', 'y@1']);
    assert.deepEqual(r.foundBySource, ['x@1']);
    assert.deepEqual(r.lost, ['y@1']);
    assert.equal(r.irrelevant, 2);
  });

  it('does not count a record expansion also missed as lost', () => {
    const r = compareCandidates({
      id: 'b',
      expected: ['x@1', 'y@1'],
      expansion: ['x@1'],
      source: ['x@1'],
    });
    assert.deepEqual(r.lost, []);
    assert.deepEqual(r.missedByBoth, ['y@1']);
  });

  it('treats a revision change as a different record', () => {
    const r = compareCandidates({
      id: 'c',
      expected: ['x@2'],
      expansion: ['x@2'],
      source: ['x@1'],
    });
    assert.deepEqual(r.lost, ['x@2']);
  });

  it('a no-answer case has nothing to lose and nothing to find', () => {
    const r = compareCandidates({ id: 'd', expected: [], expansion: ['f@1'], source: ['g@1'] });
    assert.deepEqual(r.lost, []);
    assert.equal(r.irrelevant, 1);
  });

  it('summarizes losing cases and candidates per case', () => {
    const rows = [
      compareCandidates({ id: 'a', expected: ['x@1'], expansion: ['x@1'], source: [] }),
      compareCandidates({ id: 'b', expected: ['y@1'], expansion: ['y@1'], source: ['y@1', 'q@1'] }),
      compareCandidates({ id: 'c', expected: [], expansion: [], source: ['q@1', 'r@1'] }),
    ];
    const s = summarizeComparison(rows);
    assert.deepEqual(s.losingCases, ['a']);
    assert.equal(s.cases, 3);
    assert.equal(s.neededCases, 2);
    assert.equal(s.meanCandidates, 4 / 3);
    assert.equal(s.maxCandidates, 2);
  });
});
