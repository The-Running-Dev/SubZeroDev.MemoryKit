#!/usr/bin/env node
// The memorykit executable. node:sqlite is experimental on Node 22 and announces itself
// with a warning on every run, which is noise for a CLI, so that one warning is dropped
// before anything loads SQLite. Every other warning is still printed.

process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning' && /SQLite/i.test(warning.message)) return;
  process.stderr.write(`${warning.name}: ${warning.message}\n`);
});

const { run } = await import('./run.ts');
process.exitCode = await run(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
