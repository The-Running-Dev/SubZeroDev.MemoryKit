// Query work benchmark (S16.1). It builds synthetic stores of each size, then runs the storage
// adapter's own SQL and scan loop on them, without the SDK, and reports for each query shape
// the time to the first row, the time to a full page of 10 and the query plan.
//
//   node eval/retrieval/run.ts --work [--sizes 10000,50000,100000] [--repeat 5] [--out work.md]
//
// The rows are written straight into the tables, in one transaction, so a 100,000-row store
// builds in seconds. They are synthetic: generated words, 100 namespaces of about 1% each, one
// namespace of 20 rows, 10% archived, a word in 90% of the memories, a word in exactly 10, and a
// metadata value in 0.1%.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { StorageSearch } from '../../src/contracts/index.ts';
import { metadataText } from '../../src/model/index.ts';
import { DATABASE_FILE, initStore } from '../../src/sdk/index.ts';
import { scan, scanSql } from '../../src/storage-sqlite/index.ts';

const PAGE = 10;
const BUDGET = 10_000; // the adapter's default scan budget
const COMMON = 'harbor';
const RARE = 'lighthouse';
const SMALL = 'solo/notes';
const SMALL_ROWS = 20;
const FINGERPRINT = 'work';
const ORDERING_INDEX = 'CREATE INDEX memories_updated ON memories(updated_at DESC, id)';

interface Shape {
  name: string;
  query: Partial<StorageSearch>;
}

// The six S16.1 shapes, then checks that a small scope is not scanned through a wider index.
const SHAPES: Shape[] = [
  { name: 'a term matching most memories', query: { text: COMMON } },
  { name: 'a rare term', query: { text: RARE } },
  { name: 'a term within one namespace', query: { text: COMMON, patterns: ['team/3/proj/3'] } },
  { name: 'a namespace prefix, no text', query: { patterns: ['team/3/*'] } },
  { name: 'all readable namespaces, no text', query: {} },
  { name: 'a selective metadata filter', query: { metadata: { batch: 7 } } },
  { name: 'a small namespace prefix, no text', query: { patterns: ['solo/*'] } },
  {
    name: 'a small namespace in two states, no text',
    query: { patterns: [SMALL], states: ['active', 'archived'] },
  },
];

// The text query before S16, kept to measure the S16.4 rule against.
const UNCAPPED =
  'SELECT * FROM (SELECT m.*, bm25(memories_fts) AS rank, memories_fts.rowid AS fts_rowid ' +
  'FROM memories_fts JOIN memories m ON m.id = memories_fts.id WHERE memories_fts MATCH ?) ' +
  "WHERE state IN ('active') ORDER BY rank, id";

function search(shape: Shape): StorageSearch {
  return {
    states: ['active'],
    limit: PAGE,
    patterns: ['*'],
    readable: ['*'],
    ...shape.query,
  } as StorageSearch;
}

// mulberry32: a small seeded generator, so every run builds the same store.
function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function words(next: () => number, count: number): string[] {
  const syllables = ['ka', 'lo', 'mi', 'ne', 'ru', 'sa', 'ti', 'vo', 'ze', 'qu', 'pa', 'do'];
  const result = new Set<string>();
  while (result.size < count) {
    let word = '';
    const length = 2 + Math.floor(next() * 3);
    for (let i = 0; i < length; i++) word += syllables[Math.floor(next() * syllables.length)];
    if (word !== COMMON && word !== RARE) result.add(word);
  }
  return [...result];
}

async function build(dir: string, size: number): Promise<DatabaseSync> {
  await initStore({ path: dir, history: { provider: 'none' } });
  const db = new DatabaseSync(join(dir, DATABASE_FILE));
  const next = random(size);
  const vocabulary = words(next, 5000);
  const order = Array.from({ length: size }, (_, i) => i);
  for (let i = size - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  const rare = new Set(Array.from({ length: 10 }, (_, i) => Math.floor((i * size) / 10) + 3));
  const memory = db.prepare(
    'INSERT INTO memories (id, namespace, key, kind, content, content_type, metadata, provenance, ' +
      "state, prior_state, revision, actor, created_at, updated_at) VALUES (?, ?, NULL, 'note', ?, " +
      "'text/plain', ?, '{\"evidence\":[]}', ?, ?, 1, 'eval', ?, ?)"
  );
  const fts = db.prepare(
    "INSERT INTO memories_fts (id, kind, content, metadata_text) VALUES (?, 'note', ?, ?)"
  );
  const start = Date.UTC(2026, 0, 1);
  db.exec('BEGIN');
  for (let i = 0; i < size; i++) {
    const id = '01J' + i.toString(32).toUpperCase().padStart(23, '0');
    const namespace =
      i < SMALL_ROWS ? SMALL : `team/${Math.floor(next() * 10)}/proj/${Math.floor(next() * 10)}`;
    const text = Array.from({ length: 30 }, () => vocabulary[Math.floor(next() * 5000)]!);
    if (next() < 0.9) text.splice(Math.floor(next() * 30), 0, COMMON);
    if (rare.has(i)) text.splice(Math.floor(next() * 30), 0, RARE);
    const content = text.join(' ');
    const metadata = { batch: i % 1000 };
    const archived = i % 10 === 9;
    const at = new Date(start + order[i]! * 1000).toISOString();
    memory.run(
      id,
      namespace,
      content,
      JSON.stringify(metadata),
      archived ? 'archived' : 'active',
      archived ? 'active' : null,
      at,
      at
    );
    fts.run(id, content, metadataText(metadata));
  }
  db.exec('COMMIT');
  return db;
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
};

function firstRow(db: DatabaseSync, sql: string, params: SQLInputValue[], repeat: number): number {
  const times: number[] = [];
  for (let i = 0; i <= repeat; i++) {
    const begin = performance.now();
    const rows = db.prepare(sql).iterate(...params);
    rows.next();
    const elapsed = performance.now() - begin;
    rows.return?.();
    if (i > 0) times.push(elapsed); // the first run warms the page cache
  }
  return median(times);
}

interface Measured {
  shape: string;
  first: number;
  page: number;
  rows: number;
  items: number;
  partial: boolean;
  plan: string[];
}

function measure(db: DatabaseSync, shape: Shape, repeat: number): Measured {
  const query = search(shape);
  const { sql, params } = scanSql(query, FINGERPRINT, BUDGET);
  const first = firstRow(db, sql, params, repeat);
  const times: number[] = [];
  let result = { rows: 0, items: 0, partial: false };
  for (let i = 0; i <= repeat; i++) {
    let items = 0;
    const begin = performance.now();
    const { rows, partial } = scan(
      db,
      query,
      FINGERPRINT,
      BUDGET,
      () => items < PAGE && ++items > 0
    );
    if (i > 0) times.push(performance.now() - begin);
    result = { rows, items, partial };
  }
  return { shape: shape.name, first, page: median(times), ...result, plan: plan(db, sql, params) };
}

function plan(db: DatabaseSync, sql: string, params: SQLInputValue[]): string[] {
  const rows = db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...params) as Array<{
    id: number;
    parent: number;
    detail: string;
  }>;
  const depth = new Map<number, number>([[0, -1]]);
  return rows.map((row) => {
    const level = (depth.get(row.parent) ?? -1) + 1;
    depth.set(row.id, level);
    return '  '.repeat(level) + row.detail;
  });
}

function hasIndex(db: DatabaseSync, name: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'index' AND name = ?").get(name) !==
    undefined
  );
}

interface Size {
  size: number;
  results: Measured[];
  ordering: { without: number; with: number };
  uncapped: number;
}

function run(db: DatabaseSync, size: number, repeat: number): Size {
  const results = SHAPES.map((shape) => measure(db, shape, repeat));
  // S16.3: the listing over all namespaces, with and without the ordering index.
  const all = scanSql(search(SHAPES[4]!), FINGERPRINT, BUDGET);
  const built = hasIndex(db, 'memories_updated');
  db.exec(built ? 'DROP INDEX memories_updated' : ORDERING_INDEX);
  const toggled = firstRow(db, all.sql, all.params, repeat);
  db.exec(built ? ORDERING_INDEX : 'DROP INDEX memories_updated');
  const current = results[4]!.first;
  const ordering = built
    ? { without: toggled, with: current }
    : { without: current, with: toggled };
  // S16.4: the common term under the text query before S16.
  const uncapped = firstRow(db, UNCAPPED, [`"${COMMON}"`], repeat);
  return { size, results, ordering, uncapped };
}

const ms = (value: number): string => value.toFixed(2);
const count = (value: number): string => value.toLocaleString('en');

export async function workReport(
  sizes: number[],
  repeat: number,
  environment: string
): Promise<string> {
  const runs: Size[] = [];
  let plans: Measured[] = [];
  for (const size of sizes) {
    console.error(`Measuring query work at ${count(size)} memories...`);
    const dir = mkdtempSync(join(tmpdir(), 'memorykit-work-'));
    try {
      const db = await build(dir, size);
      try {
        const result = run(db, size, repeat);
        runs.push(result);
        plans = result.results;
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const at = (size: number): Size | undefined => runs.find((r) => r.size === size);
  const fifty = at(50_000);
  const hundred = at(100_000);
  const lines = [
    '# Query work',
    '',
    environment,
    '',
    `Synthetic stores built straight into the tables: 100 namespaces \`team/N/proj/M\` of about 1% each, \`${SMALL}\` with ${SMALL_ROWS} rows, 10% archived, "${COMMON}" in about 90% of memories, "${RARE}" in 10, and metadata \`batch\` = 7 in 0.1%. Each query runs the adapter's own SQL (\`scanSql\`) and scan loop (\`scan\`) on a file database, without the SDK, with the default scan budget of ${count(BUDGET)}, active memories only unless the shape says otherwise. Times are medians of ${repeat} runs after one warm-up run. First row is preparing the statement and reading one row; page is the scan loop until ${PAGE} items, the budget or the end.`,
    '',
  ];
  for (const run of runs) {
    lines.push(
      `## ${count(run.size)} memories`,
      '',
      '| Shape | First row (ms) | Page (ms) | Rows examined | Items | Partial |',
      '| --- | --- | --- | --- | --- | --- |',
      ...run.results.map(
        (r) =>
          `| ${r.shape} | ${ms(r.first)} | ${ms(r.page)} | ${count(r.rows)} | ${r.items} | ${r.partial ? 'yes' : 'no'} |`
      ),
      ''
    );
  }
  lines.push(
    '## Decision rules',
    '',
    'Fixed in `design/30-slices.md` before the benchmark ran.',
    '',
    '| Rule | Measured | Applies |',
    '| --- | --- | --- |'
  );
  if (fifty !== undefined) {
    const speedup = fifty.ordering.without / fifty.ordering.with;
    lines.push(
      `| S16.3: an ordering index makes the first row of a listing over all namespaces at least twice as fast at 50,000 | ${ms(fifty.ordering.without)} ms without, ${ms(fifty.ordering.with)} ms with (${speedup.toFixed(1)}×) | ${speedup >= 2 ? 'yes' : 'no'} |`
    );
  }
  if (hundred !== undefined) {
    lines.push(
      `| S16.4: the first row of a term matching most memories at 100,000 takes more than 50 ms with the text query before S16 | ${ms(hundred.uncapped)} ms before, ${ms(hundred.results[0]!.first)} ms now | ${hundred.uncapped > 50 ? 'yes' : 'no'} |`
    );
  }
  lines.push('', `## Query plans at ${count(runs.at(-1)?.size ?? 0)} memories`, '');
  for (const r of plans) lines.push(`${r.shape}:`, '', '```text', ...r.plan, '```', '');
  return lines.join('\n');
}
