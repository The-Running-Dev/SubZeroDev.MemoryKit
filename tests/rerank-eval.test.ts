import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { before, describe, it } from 'node:test';
import type { Embedder } from '../eval/retrieval/embed.ts';
import {
  applyRule,
  hardFailures,
  type Measured,
  type QueryLists,
} from '../eval/retrieval/fusion.ts';
import type { Quality, Summary } from '../eval/retrieval/harness.ts';
import { evaluate, type Reranker, type RerankEvaluation } from '../eval/retrieval/rerank.ts';
import {
  COST_CONDITION,
  DEPTHS,
  SOURCES,
  THRESHOLDS,
  chooseRerank,
  configsFor,
  failedRerankConditions,
  rerank,
  sourceList,
  type RerankCandidate,
  type Source,
} from '../eval/retrieval/reranking.ts';

const BASELINE = new URL('../eval/retrieval/baseline.json', import.meta.url);

const words = (text: string) => text.toLowerCase().match(/[a-z0-9]+/g) ?? [];

// Stand-in models. The embedder hashes each word into one of 64 dimensions; the reranker's
// relevance is the share of the query's words the memory holds. Enough to drive every
// configuration without loading a real model.
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
      for (const word of words(text)) {
        let hash = 0;
        for (const char of word) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
        vector[hash % dimensions]! += 1;
      }
      return Promise.resolve(vector);
    },
  });
}

function fakeReranker(model: string): Promise<Reranker> {
  return Promise.resolve({
    model,
    revision: 'fake',
    dtype: 'fp32',
    package: 'none',
    maxTokens: 512,
    diskBytes: model.length,
    score(query: string, documents: string[]) {
      const asked = words(query);
      return Promise.resolve(
        documents.map((document) => {
          const held = new Set(words(document));
          return asked.length === 0 ? 0 : asked.filter((w) => held.has(w)).length / asked.length;
        })
      );
    },
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

const measured = (overall: Summary): Measured => ({
  overall,
  categories: new Map([
    ['exact', { ...overall, recall5: 1 }],
    ['paraphrase', overall],
  ]),
});

const candidate = (
  corpus: Measured,
  options: { heldout?: Measured; cost?: number; bytes?: number; depth?: number } = {}
): RerankCandidate => ({
  config: { reranker: 'r', source: 'retrieve', depth: options.depth ?? 10, threshold: 0.1 },
  modelBytes: options.bytes ?? 1,
  costP95: options.cost ?? 10,
  corpus,
  heldout: [options.heldout ?? corpus, options.heldout ?? corpus],
});

describe('reranking evaluation', () => {
  it('S21.3 every reranker runs every source, depth and threshold', () => {
    const configs = configsFor('r');
    assert.equal(configs.length, SOURCES.length * DEPTHS.length * THRESHOLDS.length);
    assert.deepEqual(DEPTHS, [10, 20, 50]);
    assert.deepEqual(THRESHOLDS, [0.01, 0.02, 0.05, 0.1, 0.2, 0.3, 0.5, 0.7]);
    assert.deepEqual(SOURCES, ['retrieve', 'any-word', 'fused']);
  });

  it('S21.3 the sources are S17, S17 with any word, and their fusion with vectors at 0.30', () => {
    const lists: QueryLists = {
      lexical: ['a'],
      strict: ['a', 'b'],
      relaxed: ['a', 'b', 'd'],
      eligible: ['a', 'b', 'c', 'd'],
      similarity: new Map([
        ['a', 0.2],
        ['b', 0.9],
        ['c', 0.6],
        ['d', 0.25],
      ]),
    };
    const of = (source: Source) => sourceList(source, lists);
    assert.deepEqual(of('retrieve'), ['a', 'b']);
    assert.deepEqual(of('any-word'), ['a', 'b', 'd']);
    assert.deepEqual(of('fused'), applyRule({ kind: 'fusion-relaxed', floor: 0.3 }, lists, 50));
    assert.deepEqual(of('fused'), ['b', 'a', 'c', 'd']);
  });

  it('S21.3 reranking keeps the first candidates at the threshold, by relevance, ties in order', () => {
    const relevance = new Map([
      ['a', 0.2],
      ['b', 0.9],
      ['c', 0.2],
      ['d', 0.95],
      ['e', 0.01],
    ]);
    const of = (ref: string) => relevance.get(ref)!;
    const list = ['c', 'a', 'b', 'e', 'd'];
    assert.deepEqual(rerank(list, 10, 0.05, of, 10), ['d', 'b', 'c', 'a']);
    assert.deepEqual(rerank(list, 3, 0.05, of, 10), ['b', 'c', 'a']);
    assert.deepEqual(rerank(list, 10, 0.5, of, 10), ['d', 'b']);
    assert.deepEqual(rerank(list, 10, 0.01, of, 2), ['d', 'b']);
    assert.deepEqual(rerank(list, 10, 0.99, of, 10), []);
  });

  it('S21.4 the choice takes the best qualifying configuration within the cost', () => {
    const weak = candidate(measured(summary(0.95, 0.7, 1)));
    const slow = candidate(measured(summary(1, 0.9, 0)), { cost: 51 });
    const good = candidate(measured(summary(0.92, 0.8, 1)));
    const smaller = candidate(measured(summary(0.92, 0.8, 1)), { bytes: 0, depth: 50 });
    const shallower = candidate(measured(summary(0.92, 0.8, 1)), { bytes: 0, depth: 20 });
    assert.deepEqual(failedRerankConditions(slow), [COST_CONDITION]);
    const choice = chooseRerank([weak, slow, good, smaller, shallower]);
    assert.equal(choice.chosen, shallower);
    assert.equal(choice.qualifying, 3);
    assert.deepEqual(choice.gate, { passed: true, reasons: [] });
  });

  it('S21.5 the gate fails when nothing qualifies, or the held-out sets fall short', () => {
    const slow = chooseRerank([candidate(measured(summary(1, 0.9, 0)), { cost: 80 })]);
    assert.equal(slow.qualified, false);
    assert.deepEqual(slow.gate.reasons, ['no configuration meets every corpus condition']);
    const heldShort = chooseRerank([
      candidate(measured(summary(0.95, 0.9, 0)), { heldout: measured(summary(0.85, 0.9, 0, 0.5)) }),
    ]);
    assert.equal(heldShort.qualified, true);
    assert.deepEqual(heldShort.gate.reasons, [
      'held-out set 1 recall@10 0.850 < 0.90',
      'held-out set 1 no-answer 0.500 > 0.20',
      'held-out set 2 recall@10 0.850 < 0.90',
      'held-out set 2 no-answer 0.500 > 0.20',
    ]);
  });

  describe('with stand-in models', () => {
    let evaluation: RerankEvaluation;
    before(async () => {
      evaluation = await evaluate(
        ['fake-small', 'fake-larger'],
        false,
        1,
        { reranker: fakeReranker, embedder: fakeEmbedder },
        false
      );
    });

    it('S21.3 the S17 reference row scores as the S17 baseline records', () => {
      const recorded = JSON.parse(readFileSync(BASELINE, 'utf8')) as {
        runs: Array<{ filler: number; retrieve: Quality; heldout: Quality }>;
      };
      const base = recorded.runs.find((run) => run.filler === 0)!;
      const lexical = evaluation.references[0]!;
      const round = (value: number) => Math.round(value * 10_000) / 10_000;
      assert.equal(round(lexical.corpus.overall.recall10), base.retrieve.overall.recall10);
      assert.equal(round(lexical.corpus.overall.mrr), base.retrieve.overall.mrr);
      assert.equal(round(lexical.heldout[0]!.overall.recall10), base.heldout.overall.recall10);
      assert.equal(evaluation.references.length, 2);
    });

    it('S21.3 every configuration runs on every set, and none exposes or returns anything obsolete', () => {
      assert.equal(evaluation.ranked.length, 2 * configsFor('r').length);
      assert.deepEqual(
        evaluation.sets.map((s) => s.name),
        ['corpus', 'heldout.json', 'heldout-2.json']
      );
      for (const c of evaluation.ranked) {
        assert.ok(Number.isFinite(c.costP95));
        for (const set of [c.corpus, ...c.heldout]) assert.deepEqual(hardFailures(set), []);
      }
    });

    it('S21.3 a lower threshold never returns fewer results for the same source and depth', () => {
      for (const source of SOURCES) {
        for (const depth of DEPTHS) {
          const rows = evaluation.ranked.filter(
            (c) =>
              c.config.reranker === 'fake-small' &&
              c.config.source === source &&
              c.config.depth === depth
          );
          const returned = rows.map((c) =>
            c.scores[0]!.reduce((total, s) => total + s.returned.length, 0)
          );
          assert.deepEqual(
            returned,
            [...returned].sort((a, b) => b - a),
            `${source} ${depth}`
          );
        }
      }
    });

    it('S21.6 scoring time is measured for every source and depth of each reranker', () => {
      for (const reranker of evaluation.rerankers) {
        const costs = evaluation.costs.get(reranker.model)!;
        assert.equal(costs.scoring.size, SOURCES.length * DEPTHS.length);
        assert.equal(costs.cold, null);
      }
    });
  });
});
