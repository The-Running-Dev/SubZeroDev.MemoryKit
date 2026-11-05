// Summarize recorded evidence; this never invokes a provider or changes readiness gates.
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { percentiles } from '../eval/retrieval/harness.ts';

const { values } = parseArgs({ options: {
  report: { type: 'string' }, timings: { type: 'string' }, output: { type: 'string' },
} });
if (!values.report) throw new Error('Supply --report with an existing qualification report');
type Phase = {task: string; ms: number; completed: boolean};
type Row = {id: string; ms?: number; phases?: Phase[]; skipped?: string};
const report = JSON.parse(readFileSync(values.report, 'utf8')) as {
  provider: string; rows: Row[]; cost: unknown; warm: unknown;
};
const rows = report.rows.filter((r): r is Row & {ms: number} => !r.skipped && Number.isFinite(r.ms));
if (!rows.length) throw new Error('Report contains no measured rows');
const totalMs = rows.reduce((sum, row) => sum + row.ms, 0);
const phaseSummary = ['expand', 'select', 'verify'].map(task => {
  const phases = rows.flatMap(row => (row.phases ?? []).filter(p => p.task === task));
  const sumMs = phases.reduce((sum, p) => sum + p.ms, 0);
  return { task, calls: phases.length, completed: phases.filter(p => p.completed).length,
    totalMs: sumMs, fractionOfTotal: sumMs / totalMs, ...percentiles(phases.map(p => p.ms)) };
});
const other = rows.map(row => row.ms - (row.phases ?? []).reduce((sum, p) => sum + p.ms, 0));
const sorted = [...rows].sort((a,b) => a.ms-b.ms);
const p95 = sorted[Math.ceil(.95 * rows.length)-1]!;
const timingRows = values.timings
  ? readFileSync(values.timings, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  : [];
const summary = {
  version: 1, provider: report.provider, measuredCases: rows.length,
  coldLatencyMs: percentiles(rows.map(row => row.ms)),
  phaseSummary, nonProviderMs: {total: other.reduce((a,b)=>a+b,0), ...percentiles(other)},
  p95Case: {id: p95.id, ms: p95.ms, phases: p95.phases,
    otherMs: p95.ms - (p95.phases ?? []).reduce((sum,p)=>sum+p.ms,0)},
  cost: report.cost, warm: report.warm,
  lifecycle: timingRows.length ? {
    attempts: timingRows.length, succeeded: timingRows.filter(row => row.succeeded).length,
    groups: [false, true].map(catalogCopied => ({catalogCopied,
      ...Object.fromEntries(['adapterMs','setupMs','spawnMs','firstEventMs','threadStartedMs',
        'turnStartedMs','turnMs','exitAfterTurnMs','processMs'].map(key => {
          const samples = timingRows.filter(row => row.catalogCopied === catalogCopied)
            .flatMap(row => Number.isFinite(row[key]) ? [row[key]] : []);
          return [key, {samples: samples.length, ...percentiles(samples)}];
        })),
    })),
  } : null,
  limits: [
    'Recorded phase costs include adapter/CLI startup and provider execution; they do not separate them.',
    'Lifecycle events are timing boundaries, not server-side inference metrics. turnMs includes transport and provider work.',
    'Percentiles use the qualification harness nearest-rank method. Phase p95 values must not be summed.',
    'This analysis is not a new quality or readiness qualification. The cold p95 threshold remains 10000 ms.',
  ],
};
const json = JSON.stringify(summary, null, 2) + '\n';
if (values.output) writeFileSync(values.output, json);
else process.stdout.write(json);
