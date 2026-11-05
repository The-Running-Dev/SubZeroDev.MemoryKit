import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import { commandJson } from '../src/providers-command/index.ts';
import { tempDir } from './helpers.ts';

it('records only bounded numeric Ollama timings and retains the existing output protocol', async () => {
  const file = join(tempDir(), 'timing.jsonl');
  let fail = false;
  const server = createServer((req,res) => {
    req.resume();
    res.setHeader('content-type','application/json');
    if (fail) {res.writeHead(503);res.end('private server error');return;}
    res.end(JSON.stringify({message:{content:'{"queries":["bicycle"],"subject":"PRIVATE_SUBJECT"}'},
      total_duration:123000000,load_duration:20000000,prompt_eval_duration:30000000,eval_duration:73000000,
      private_field:'PRIVATE_MODEL_OUTPUT'}));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const address=server.address(); assert.ok(address && typeof address !== 'string');
    const command={command:process.execPath,args:[fileURLToPath(new URL('../examples/ollama-provider.mjs',import.meta.url)),
      '--model','synthetic','--url',`http://127.0.0.1:${address.port}`,'--timings',file]};
    const request={version:1,task:'expand',query:'PRIVATE_QUERY'};
    assert.deepEqual(await commandJson(command,request),{queries:['bicycle']});
    fail=true;
    await assert.rejects(commandJson(command,request),/provider failed/);
    const raw=readFileSync(file,'utf8');
    assert.doesNotMatch(raw,/PRIVATE|bicycle|private server error/);
    const [first,second]=raw.trim().split('\n').map(line=>JSON.parse(line));
    assert.equal(first.httpSucceeded,true);
    assert.equal(first.totalMs,123);
    assert.equal(first.loadMs,20);
    assert.equal(first.prompt_evalMs,30);
    assert.equal(first.evalMs,73);
    assert.equal(second.httpSucceeded,false);
    assert.equal(second.totalMs,undefined);
  } finally {await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
