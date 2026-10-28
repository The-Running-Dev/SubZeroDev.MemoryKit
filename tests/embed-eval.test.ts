import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { before, describe, it } from 'node:test';
import {
  HELDOUT_2_FILE,
  evaluate,
  type Embedder,
  type Evaluation,
} from '../eval/retrieval/embed.ts';
import {
  FLOORS,
  HYBRID_RULES,
  applyRule,
  choose,
  fuse,
  hardFailures,
  type Candidate,
  type Measured,
  type QueryLists,
} from '../eval/retrieval/fusion.ts';
import {
  expectedModel,
  loadCorpus,
  loadHeldout,
  quality,
  type Quality,
  type Summary,
} from '../eval/retrieval/harness.ts';

const ROOT = new URL('../', import.meta.url);
const BASELINE = new URL('../eval/retrieval/baseline.json', import.meta.url);
const RUNTIME = '@huggingface/transformers';

// A stand-in model: each word hashed into one of 64 dimensions, so memories that share words
// with a query are similar to it. Enough to drive every rule without loading a real model.
function fakeEmbedder(model: string): Promise<Embedder> {
  const dimensions = 64;
  return Promise.resolve({
    model,
    revision: 'fake',
    dtype: 'fp32',
    prefix: '',
    pooling: 'none',
    package: 'none',
    dimensions,
    diskBytes: 0,
    embed(text: string) {
      const vector = new Float32Array(dimensions);
      for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
        let hash = 0;
        for (const char of word) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
        vector[hash % dimensions]! += 1;
      }
      return Promise.resolve(vector);
    },
  });
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

const summary = (recall10: number, mrr: number, nonRelevant10: number, noAnswer = 0): Summary =>
  ({
    queries: 1,
    answerable: 1,
    errors: 0,
    recall5: 1,
    recall10,
    mrr,
    ndcg10: 1,
    nonRelevant10,
    noAnswer: 1,
    noAnswerReturned: noAnswer,
    obsolete: 0,
    exposure: 0,
    duplicates: 0,
    fetches: 0,
    pages: 1,
    partialPages: 0,
    latency: { p50: 0, p95: 0 },
    bytes: { p50: 0, p95: 0, max: 0 },
  }) satisfies Summary;

const measured = (overall: Summary, paraphrase = overall.recall10): Measured => ({
  overall,
  categories: new Map([
    ['exact', { ...overall, recall5: 1 }],
    ['paraphrase', { ...overall, recall10: paraphrase }],
  ]),
});

const candidate = (floor: number, corpus: Measured, heldout = corpus): Candidate => ({
  model: 'm',
  rule: { kind: 'fusion', floor },
  corpus,
  heldout: [heldout, heldout],
});

describe('embedding evaluation', () => {
  it('S18.1 the second held-out set covers its cases and agrees with the corpus', () => {
    const corpus = loadCorpus();
    const held = loadHeldout(corpus, HELDOUT_2_FILE);
    const count = (category: string) => held.queries.filter((q) => q.category === category).length;
    assert.ok(count('paraphrase') >= 12);
    assert.ok(count('distractor') >= 6);
    assert.ok(count('no-answer') >= 12);
    const model = expectedModel(corpus);
    const first = new Set(loadHeldout(corpus).queries.map((q) => q.search.text));
    for (const query of held.queries) {
      assert.ok(query.search.text !== undefined && !first.has(query.search.text), query.id);
      for (const expected of query.relevant ?? []) {
        assert.equal(model.get(expected.ref)?.revision, expected.revision, query.id);
      }
    }
  });

  it('S18.2 the model runtime is installed and imported only under eval/embed', () => {
    for (const file of ['package.json', 'package-lock.json']) {
      assert.ok(!readFileSync(new URL(file, ROOT), 'utf8').includes(RUNTIME), file);
    }
    const embed = JSON.parse(readFileSync(new URL('eval/embed/package.json', ROOT), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    assert.match(embed.dependencies[RUNTIME]!, /^\d+\.\d+\.\d+$/);
    for (const dir of ['src', 'tests', 'eval/retrieval']) {
      for (const file of files(fileURLToPath(new URL(dir, ROOT)))) {
        if (!file.endsWith('.ts') || file.endsWith('embed-eval.test.ts')) continue;
        assert.ok(!readFileSync(file, 'utf8').includes(RUNTIME), file);
      }
    }
  });

  it('S18.3 fusion ranks by reciprocal rank, floors cut vectors, and gating drops the rest', () => {
    assert.equal(HYBRID_RULES.length, 1 + 5 * FLOORS.length);
    assert.deepEqual(FLOORS, [0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8]);
    assert.deepEqual(
      fuse(
        [
          ['a', 'b'],
          ['b', 'c'],
        ],
        () => 0
      ),
      ['b', 'a', 'c']
    );
    const lists: QueryLists = {
      lexical: ['a'],
      strict: ['a'],
      relaxed: ['a', 'd'],
      eligible: ['a', 'b', 'c', 'd'],
      similarity: new Map([
        ['a', 0.2],
        ['b', 0.9],
        ['c', 0.6],
        ['d', 0.4],
      ]),
    };
    assert.deepEqual(applyRule({ kind: 'lexical', floor: null }, lists, 10), ['a']);
    assert.deepEqual(applyRule({ kind: 'vector', floor: 0.5 }, lists, 10), ['b', 'c']);
    assert.deepEqual(applyRule({ kind: 'fusion', floor: 0.5 }, lists, 10), ['b', 'a', 'c']);
    assert.deepEqual(applyRule({ kind: 'gated', floor: 0.5 }, lists, 10), ['b', 'c']);
    assert.deepEqual(applyRule({ kind: 'fusion-relaxed', floor: 0.5 }, lists, 10), [
      'b',
      'a',
      'c',
      'd',
    ]);
    // d is in both lists, so it leads; a falls below the floor.
    assert.deepEqual(applyRule({ kind: 'gated-relaxed', floor: 0.35 }, lists, 2), ['d', 'b']);
  });

  it('S18.4 the choice takes the qualifying rule with the best recall, MRR, then precision', () => {
    const weak = candidate(0.3, measured(summary(0.95, 0.7, 1)));
    const good = candidate(0.4, measured(summary(0.92, 0.8, 1)));
    const better = candidate(0.5, measured(summary(0.92, 0.8, 0.5)));
    const choice = choose([weak, good, better]);
    assert.equal(choice.chosen, better);
    assert.equal(choice.qualifying, 2);
    assert.deepEqual(choice.gate, { passed: true, reasons: [] });
  });

  it('S18.5 the gate fails when nothing qualifies, or the held-out sets fall short', () => {
    const none = choose([candidate(0.3, measured(summary(0.8, 0.9, 0)))]);
    assert.equal(none.qualified, false);
    assert.equal(none.gate.passed, false);
    const heldShort = choose([
      candidate(0.3, measured(summary(0.95, 0.9, 0)), measured(summary(0.85, 0.9, 0, 0.5))),
    ]);
    assert.equal(heldShort.qualified, true);
    assert.deepEqual(heldShort.gate.reasons, [
      'held-out set 1 recall@10 0.850 < 0.90',
      'held-out set 1 no-answer 0.500 > 0.20',
      'held-out set 2 recall@10 0.850 < 0.90',
      'held-out set 2 no-answer 0.500 > 0.20',
    ]);
  });

  describe('with a stand-in model', () => {
    let evaluation: Evaluation;
    before(async () => {
      evaluation = await evaluate(['fake'], false, 1, fakeEmbedder, false);
    });

    it('S18.3 the lexical rule scores as the S17 baseline records', () => {
      const recorded = JSON.parse(readFileSync(BASELINE, 'utf8')) as {
        runs: Array<{ filler: number; retrieve: Quality; heldout: Quality }>;
      };
      const base = recorded.runs.find((run) => run.filler === 0)!;
      const lexical = evaluation.ranked.find((c) => c.rule.kind === 'lexical')!;
      assert.equal(lexical.model, null);
      assert.deepEqual(quality(lexical.scores[0]!), base.retrieve);
      assert.deepEqual(quality(lexical.scores[1]!), base.heldout);
    });

    it('S18.3 every rule runs on every set, and none exposes or returns anything obsolete', () => {
      assert.equal(evaluation.ranked.length, HYBRID_RULES.length);
      assert.deepEqual(
        evaluation.sets.map((s) => s.name),
        ['corpus', 'heldout.json', 'heldout-2.json']
      );
      for (const c of evaluation.ranked) {
        for (const set of [c.corpus, ...c.heldout]) assert.deepEqual(hardFailures(set), []);
      }
    });
  });
});
