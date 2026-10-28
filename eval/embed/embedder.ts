// The embedding models S18 compares, run in process through @huggingface/transformers. Only
// this directory installs the package, so the root install, the tests and CI never load it.
// Models come from .cache/ here; a missing file is fetched only when downloads are allowed.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env, pipeline } from '@huggingface/transformers';

const CACHE = fileURLToPath(new URL('.cache/', import.meta.url));
const PACKAGE = new URL('node_modules/@huggingface/transformers/package.json', import.meta.url);
const DTYPE = 'fp32';

// Each model pinned to a commit. bge ranks a query against passages with its retrieval
// instruction in front of the query; MiniLM takes the query as it is.
interface ModelSpec {
  revision: string;
  pooling: 'mean' | 'cls';
  prefix: string;
}

const MODELS: Record<string, ModelSpec> = {
  'Xenova/all-MiniLM-L6-v2': {
    revision: '751bff37182d3f1213fa05d7196b954e230abad9',
    pooling: 'mean',
    prefix: '',
  },
  'Xenova/bge-small-en-v1.5': {
    revision: 'ea104dacec62c0de699686887e3f920caeb4f3e3',
    pooling: 'cls',
    prefix: 'Represent this sentence for searching relevant passages: ',
  },
};

function sizeOf(path: string): number {
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.size;
  return readdirSync(path).reduce((total, name) => total + sizeOf(join(path, name)), 0);
}

export async function createEmbedder(model: string, allowDownload: boolean) {
  const spec = MODELS[model];
  if (spec === undefined) {
    throw new Error(`Unknown model ${model}; known: ${Object.keys(MODELS).join(', ')}`);
  }
  // A download fetches the pinned revision into the cache, keyed by revision. Offline, the model
  // loads from that revision's directory as a local path, with remote models off: the package
  // looks up which tokenizer files exist without the revision, so it cannot read them from the
  // cache by repository id.
  const local = join(CACHE, model, spec.revision);
  env.cacheDir = CACHE;
  env.useFSCache = allowDownload;
  env.allowRemoteModels = allowDownload;
  env.allowLocalModels = !allowDownload;
  const extractor = allowDownload
    ? await pipeline('feature-extraction', model, { revision: spec.revision, dtype: DTYPE })
    : await pipeline('feature-extraction', local.replaceAll('\\', '/'), { dtype: DTYPE });
  return {
    model,
    revision: spec.revision,
    dtype: DTYPE,
    prefix: spec.prefix,
    pooling: spec.pooling,
    package: `@huggingface/transformers ${JSON.parse(readFileSync(PACKAGE, 'utf8')).version}`,
    dimensions: (extractor.model.config as unknown as { hidden_size: number }).hidden_size,
    diskBytes: sizeOf(local),
    async embed(text: string, role: 'query' | 'document') {
      const input = role === 'query' ? spec.prefix + text : text;
      const output = await extractor(input, { pooling: spec.pooling, normalize: true });
      return Float32Array.from(output.data);
    },
  };
}
