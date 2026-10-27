import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { before, describe, it } from 'node:test';
import {
  buildStore,
  expectedModel,
  loadCorpus,
  percentiles,
  quality,
  rankMetrics,
  readable,
  runQueries,
  summarize,
  type QueryScore,
  type Quality,
} from '../eval/retrieval/harness.ts';
import { tempDir } from './helpers.ts';

const BASELINE = new URL('../eval/retrieval/baseline.json', import.meta.url);
const CATEGORIES = [
  'exact',
  'paraphrase',
  'correction',
  'historical',
  'lifecycle',
  'distractor',
  'cross-namespace',
  'sparse-filter',
  'large-content',
  'no-answer',
  'duplicate',
  'error',
];

describe('retrieval evaluation', () => {
  const corpus = loadCorpus();
  let scores: QueryScore[];

  before(async () => {
    const dir = tempDir();
    const built = await buildStore(dir, corpus);
    scores = await runQueries(dir, corpus, built);
  });

  it('S14.1 the corpus covers every case, and its expectations agree with its own steps', () => {
    const model = expectedModel(corpus);
    assert.deepEqual(
      [...new Set(corpus.queries.map((q) => q.category))].sort(),
      [...CATEGORIES].sort()
    );
    assert.equal(new Set(corpus.queries.map((q) => q.id)).size, corpus.queries.length);
    for (const query of corpus.queries) {
      if (query.principal !== undefined) assert.ok(corpus.principals[query.principal], query.id);
      assert.ok(query.error === undefined || query.relevant === undefined, query.id);
      for (const { ref, revision } of query.relevant ?? []) {
        assert.equal(model.get(ref)?.revision, revision, `${query.id} expects ${ref}`);
      }
    }
  });

  it('S14.2 every query that must fail does so with its code, and no other query fails', () => {
    for (const s of scores) {
      const query = corpus.queries.find((q) => q.id === s.id)!;
      assert.equal(s.outcome, query.error === undefined ? 'ok' : 'expected-error', s.id);
    }
  });

  it('S14.3 ranking metrics follow their definitions', () => {
    // Two relevant items, found at ranks 2 and 4 among five results.
    const metrics = rankMetrics([false, true, false, true, false], 2);
    assert.equal(metrics.rank, 2);
    assert.equal(metrics.recall5, 1);
    assert.equal(metrics.reciprocalRank, 0.5);
    assert.equal(metrics.nonRelevant10, 3);
    const dcg = 1 / Math.log2(3) + 1 / Math.log2(5);
    assert.equal(metrics.ndcg10, dcg / (1 + 1 / Math.log2(3)));
    // Only one of three relevant items in the top 5; nothing relevant at all.
    assert.equal(rankMetrics([true, false, false, false, false, true], 3).recall5, 1 / 3);
    assert.deepEqual(rankMetrics([false, false], 1), {
      rank: null,
      recall5: 0,
      recall10: 0,
      reciprocalRank: 0,
      ndcg10: 0,
      nonRelevant10: 2,
    });
    assert.deepEqual(percentiles([5, 1, 4, 2, 3]), { p50: 3, p95: 5 });
  });

  it('S14.3 the harness judges readability on its own', () => {
    const grants = [{ pattern: 'eval/alpha/*', permissions: ['read' as const] }];
    assert.ok(readable(grants, 'eval/alpha'));
    assert.ok(readable(grants, 'eval/alpha/filler'));
    assert.ok(!readable(grants, 'eval/alphabet'));
    assert.ok(!readable(grants, 'eval/beta'));
    assert.ok(!readable([{ pattern: 'eval/alpha', permissions: ['write'] }], 'eval/alpha'));
    assert.ok(readable(null, 'eval/beta'));
  });

  it('S14.4 nothing is exposed and no current answer is obsolete', () => {
    const overall = summarize(scores);
    assert.equal(overall.exposure, 0);
    assert.equal(overall.obsolete, 0);
    assert.equal(overall.errors, 0);
  });

  it('S14.4 quality matches the committed baseline', () => {
    const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) as {
      runs: Array<{ filler: number; quality: Quality }>;
    };
    const recorded = baseline.runs.find((run) => run.filler === 0);
    assert.ok(recorded, 'the baseline has no run without filler');
    assert.deepEqual(quality(scores), recorded.quality);
  });
});
