// One cold start for S18.6, run in its own process: importing the runtime, loading the model
// from the cache and embedding the first query. Prints the milliseconds it took.
//
//   node eval/embed/cold.ts <model>

const start = performance.now();
const { createEmbedder } = await import('./embedder.ts');
const embedder = await createEmbedder(process.argv[2] ?? '', false);
await embedder.embed('when does the Alpha pager pass to the next engineer', 'query');
console.log(JSON.stringify({ ms: performance.now() - start }));
