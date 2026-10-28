// One reranker cold start for S21.6, run in its own process: importing the runtime, loading the
// model from the cache and scoring the first query against one memory. Prints the milliseconds.
//
//   node eval/embed/cold-rerank.ts <model>

const start = performance.now();
const { createReranker } = await import('./reranker.ts');
const reranker = await createReranker(process.argv[2] ?? '', false);
await reranker.score('when does the Alpha pager pass to the next engineer', [
  'The Alpha on-call pager rotates to the next engineer every Monday at 09:00.',
]);
console.log(JSON.stringify({ ms: performance.now() - start }));
