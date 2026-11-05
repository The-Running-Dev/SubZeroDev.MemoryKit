// Controlled local transport baseline. No model and no retrieval quality assertion.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, platform, arch } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { commandJson } from '../src/providers-command/index.ts';
import { percentiles } from '../eval/retrieval/harness.ts';

const {values} = parseArgs({options:{report:{type:'string'}, samples:{type:'string',default:'30'}, codex:{type:'string'}}});
const samples = Number(values.samples);
if (!values.report || !Number.isInteger(samples) || samples < 1 || samples > 1000)
  throw new Error('Supply --report and --samples 1..1000');
const work = mkdtempSync(join(tmpdir(), 'memorykit-overhead-'));
try {
  const script = join(work, 'noop.mjs');
  writeFileSync(script, `for await (const chunk of process.stdin) void chunk;
process.stdout.write('{"selections":[]}');`);
  const groups = [];
  for (const kind of ['fresh-node-process', 'in-process-promise']) {
    const rows = [];
    for (let i=0; i<samples; i++) {
      const start = performance.now();
      const result = kind === 'fresh-node-process'
        ? await commandJson({command:process.execPath,args:[script]}, {version:1,task:'select',query:'synthetic',passages:[],limit:1})
        : await Promise.resolve({selections:[]});
      rows.push(performance.now()-start);
      if (JSON.stringify(result) !== '{"selections":[]}') throw new Error('Unexpected response');
    }
    groups.push({kind, samples, latencyMs:percentiles(rows), rows});
  }
  if (values.codex) {
    const { codexProcess } = await import(new URL('../examples/codex-process.mjs', import.meta.url).href);
    const rows = [];
    let version;
    for (let i=0; i<samples; i++) {
      const result = await codexProcess(values.codex, ['--version'], {input:'', timeout:10000});
      if (result.error || result.status !== 0 || !/^codex-cli [\w.+-]+\s*$/.test(result.stdout))
        throw new Error('Native Codex version probe failed');
      version = result.stdout.trim();
      rows.push(result.timing.processMs);
    }
    groups.push({kind:'native-codex-version-only',version,samples,latencyMs:percentiles(rows),rows});
  }
  writeFileSync(values.report, JSON.stringify({version:1, node:process.version, platform:platform(), arch:arch(), groups,
    limitation:'Transport-only baseline with empty synthetic output. Fresh Node processes use warm OS filesystem caches. No Codex startup, network, model loading, provider inference or retrieval quality is measured.'},null,2)+'\n');
} finally { rmSync(work,{recursive:true,force:true}); }
