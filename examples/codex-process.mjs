// Observe CLI lifecycle events without logging prompts, credentials or model output.
import { spawn } from 'node:child_process';

export function codexProcess(command, args, options) {
  const start = performance.now();
  const timing = {};
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd, env: options.env, windowsHide: true, shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', pending = '', bytes = 0, stderrBytes = 0, error;
    const fail = (code) => {
      error ??= { code };
      child.kill();
    };
    const timer = setTimeout(() => fail('ETIMEDOUT'), options.timeout);
    child.on('spawn', () => { timing.spawnMs = performance.now() - start; });
    child.on('error', () => { error ??= { code: 'SPAWN_FAILED' }; });
    child.stdin.on('error', () => fail('STDIN_FAILED'));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 1024 * 1024) { fail('OUTPUT_LIMIT'); return; }
      stdout += chunk;
      pending += chunk;
      let end;
      while ((end = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        try {
          const event = JSON.parse(line);
          timing.firstEventMs ??= performance.now() - start;
          const keys = { 'thread.started': 'threadStartedMs', 'turn.started': 'turnStartedMs',
            'turn.completed': 'turnCompletedMs' };
          const key = Object.hasOwn(keys, event.type) ? keys[event.type] : undefined;
          if (key) timing[key] ??= performance.now() - start;
        } catch { /* Full output validation remains in the adapter. */ }
      }
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > 1024 * 1024) fail('OUTPUT_LIMIT');
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      timing.processMs = performance.now() - start;
      if (timing.turnStartedMs !== undefined && timing.turnCompletedMs !== undefined)
        timing.turnMs = timing.turnCompletedMs - timing.turnStartedMs;
      if (timing.turnCompletedMs !== undefined)
        timing.exitAfterTurnMs = timing.processMs - timing.turnCompletedMs;
      resolve({ status, error, stdout, timing });
    });
    child.stdin.end(options.input);
  });
}
