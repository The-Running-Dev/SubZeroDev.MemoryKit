// The cross-encoder rerankers S21 compares, run in process through @huggingface/transformers.
// Each scores a (query, memory content) pair as one input; relevance is the sigmoid of its
// logit. Models come from .cache/ here; a missing file is fetched only when downloads are allowed.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AutoModelForSequenceClassification,
  AutoTokenizer,
  env,
  type Tensor,
} from '@huggingface/transformers';
import { sizeOf } from './embedder.ts';

const CACHE = fileURLToPath(new URL('.cache/', import.meta.url));
const PACKAGE = new URL('node_modules/@huggingface/transformers/package.json', import.meta.url);
const DTYPE = 'fp32';

// Each model pinned to a commit.
const MODELS: Record<string, string> = {
  'Xenova/ms-marco-MiniLM-L-6-v2': 'a09144355adeed5f58c8ed011d209bf8ee5a1fec',
  'Xenova/ms-marco-TinyBERT-L-2-v2': 'b76bb5e1fefd66aa36cd108622d768e86c015ff1',
};

const sigmoid = (logit: number) => 1 / (1 + Math.exp(-logit));

export async function createReranker(model: string, allowDownload: boolean) {
  const revision = MODELS[model];
  if (revision === undefined) {
    throw new Error(`Unknown reranker ${model}; known: ${Object.keys(MODELS).join(', ')}`);
  }
  // As in embedder.ts: a download fetches the pinned revision by repository id; offline, the
  // model loads from that revision's directory as a local path.
  const local = join(CACHE, model, revision);
  env.cacheDir = CACHE;
  env.useFSCache = allowDownload;
  env.allowRemoteModels = allowDownload;
  env.allowLocalModels = !allowDownload;
  const id = allowDownload ? model : local.replaceAll('\\', '/');
  const options = allowDownload ? { revision } : {};
  const tokenizer = await AutoTokenizer.from_pretrained(id, options);
  const classifier = await AutoModelForSequenceClassification.from_pretrained(id, {
    ...options,
    dtype: DTYPE,
  });
  const maxTokens = Number(tokenizer.model_max_length);
  return {
    model,
    revision,
    dtype: DTYPE,
    package: `@huggingface/transformers ${JSON.parse(readFileSync(PACKAGE, 'utf8')).version}`,
    maxTokens,
    diskBytes: sizeOf(local),
    // Every document against the one query, in one batch; longer pairs are truncated.
    async score(query: string, documents: string[]): Promise<number[]> {
      if (documents.length === 0) return [];
      const inputs = tokenizer(
        documents.map(() => query),
        { text_pair: documents, padding: true, truncation: true, max_length: maxTokens }
      );
      const { logits } = (await classifier(inputs)) as { logits: Tensor };
      return Array.from(logits.data as Float32Array, sigmoid);
    },
  };
}
