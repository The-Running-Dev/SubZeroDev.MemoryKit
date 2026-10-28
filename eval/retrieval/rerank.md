# Reranking evaluation (S21)

Commit `70aa9a9b5ae42e4a45481d38b6ab3795c55b5009`. Node v26.12.1 on win32 x64 (10.0.26200), 11th Gen Intel(R) Core(TM) i7-11850H @ 2.50GHz × 16, SQLite 3.54.0.

Each query's candidates come from one of three sources, each at depth 50: S17's retrieve list; S17's list with any word shared; or the reciprocal rank fusion (k = 60) of that list and the Xenova/all-MiniLM-L6-v2 vector list at floor 0.30. A cross-encoder scores the query text against each of the first 10, 20, 50 candidates' full content; relevance is the sigmoid of its logit. Candidates whose relevance reaches the threshold (0.01, 0.02, 0.05, 0.1, 0.2, 0.3, 0.5, 0.7) are ranked by relevance, ties by the source's order, then the ref, and cut to the query's limit. No filler notes.

## Models

| Model | Revision | Package | dtype | Max input tokens | Size on disk |
| --- | --- | --- | --- | --- | --- |
| Xenova/ms-marco-MiniLM-L-6-v2 | `a09144355adeed5f58c8ed011d209bf8ee5a1fec` | @huggingface/transformers 4.3.2 | fp32 | 512 | 87.5 MiB |
| Xenova/ms-marco-TinyBERT-L-2-v2 | `b76bb5e1fefd66aa36cd108622d768e86c015ff1` | @huggingface/transformers 4.3.2 | fp32 | 512 | 17.5 MiB |

Source (c) embeds with Xenova/all-MiniLM-L6-v2 at `751bff37182d3f1213fa05d7196b954e230abad9` (fp32), as in S18.

## Choice and gate

No configuration meets every corpus condition and the cost condition. The configuration named is the best by recall@10, then MRR, then the fewest non-relevant results, then the smaller model, then the smaller depth, and the gate fails.

**Best: Xenova/ms-marco-MiniLM-L-6-v2, S17, any-word share, depth 50, relevance ≥ 0.05.**

**Gate: failed.**
- no configuration meets every corpus condition
- held-out set 1 no-answer 0.750 > 0.20
- held-out set 2 recall@10 0.524 < 0.90
- held-out set 2 no-answer 0.462 > 0.20

| Condition | Limit | corpus | heldout.json | heldout-2.json |
| --- | --- | --- | --- | --- |
| retrieve unauthorized exposure | = 0 | 0 ✓ | 0 ✓ | 0 ✓ |
| retrieve obsolete results in current answers | = 0 | 0 ✓ | 0 ✓ | 0 ✓ |
| retrieve unexpected, wrong or missing errors | = 0 | 0 ✓ | 0 ✓ | 0 ✓ |
| retrieve exact-identifier recall@5 | = 1.0 | 1 ✓ | — | — |
| retrieve overall recall@10 | ≥ 0.90 | 0.939 ✓ | 1 ✓ | 0.524 ✗ |
| retrieve paraphrase recall@10 | ≥ 0.70 | 0.857 ✓ | 1 ✓ | 0.286 ✗ |
| retrieve overall MRR | ≥ 0.75 | 0.924 ✓ | 1 ✓ | 0.524 ✗ |
| retrieve mean non-relevant items in top 10 | ≤ 2 | 0.697 ✓ | 0.611 ✓ | 0.524 ✓ |
| retrieve no-answer queries returning anything | ≤ 20% | 0.250 ✗ | 0.750 ✗ | 0.462 ✗ |
| model time p95 per corpus query (ms) | ≤ 50 | 2560.9 ✗ | — | — |

The conditions choose on the corpus only. On the held-out sets the gate judges recall@10 and no-answer for the chosen configuration, and the hard conditions for every configuration.

## Reference rows

| Set | Model | Rule | Recall@5 | Recall@10 | Exact recall@5 | Paraphrase recall@10 | MRR | nDCG@10 | Non-relevant in top 10 | No-answer returning anything | Obsolete | Exposure | Errors | Duplicates | Fetches |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| corpus | — | S17 lexical | 0.909 | 0.909 | 1.000 | 0.714 | 0.870 | 0.879 | 0.70 | 0.500 | 0 | 0 | 0 | 1 | 1 |
| corpus | Xenova/all-MiniLM-L6-v2 | RRF ≥ 0.40 | 1.000 | 1.000 | 1.000 | 1.000 | 0.947 | 0.960 | 3.64 | 0.750 | 0 | 0 | 0 | 7 | 1 |
| heldout.json | — | S17 lexical | 0.944 | 0.944 | — | 1.000 | 0.917 | 0.924 | 0.33 | 0.500 | 0 | 0 | 0 | 0 | 0 |
| heldout.json | Xenova/all-MiniLM-L6-v2 | RRF ≥ 0.40 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 4.39 | 0.500 | 0 | 0 | 0 | 5 | 0 |
| heldout-2.json | — | S17 lexical | 0.429 | 0.429 | — | 0.143 | 0.397 | 0.405 | 0.62 | 0.308 | 0 | 0 | 0 | 0 | 0 |
| heldout-2.json | Xenova/all-MiniLM-L6-v2 | RRF ≥ 0.40 | 0.857 | 0.857 | — | 0.786 | 0.833 | 0.840 | 4.81 | 0.846 | 0 | 0 | 0 | 7 | 0 |

## Best of each reranker and source on the corpus

| Reranker | Source | Depth | Relevance | Recall@5 | Recall@10 | Exact recall@5 | Paraphrase recall@10 | MRR | nDCG@10 | Non-relevant in top 10 | No-answer returning anything | Obsolete | Exposure | Errors | Duplicates | Fetches | Model p95 (ms) | Conditions failed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17 retrieve | 10 | ≥ 0.05 | 0.909 | 0.909 | 1.000 | 0.714 | 0.909 | 0.909 | 0.48 | 0.250 | 0 | 0 | 0 | 1 | 1 | 68.9 | 2 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17, any-word share | 50 | ≥ 0.05 | 0.939 | 0.939 | 1.000 | 0.857 | 0.924 | 0.928 | 0.70 | 0.250 | 0 | 0 | 0 | 2 | 1 | 2560.9 | 2 |
| Xenova/ms-marco-MiniLM-L-6-v2 | RRF of any-word and vector ≥ 0.30 | 10 | ≥ 0.05 | 0.939 | 0.939 | 1.000 | 0.857 | 0.924 | 0.928 | 1.58 | 0.250 | 0 | 0 | 0 | 3 | 1 | 964.8 | 2 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17 retrieve | 10 | ≥ 0.02 | 0.848 | 0.848 | 1.000 | 0.429 | 0.783 | 0.800 | 0.42 | 0.250 | 0 | 0 | 0 | 1 | 1 | 3.28 | 3 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17, any-word share | 50 | ≥ 0.02 | 0.848 | 0.879 | 1.000 | 0.571 | 0.788 | 0.811 | 0.61 | 0.250 | 0 | 0 | 0 | 2 | 1 | 160.0 | 4 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | RRF of any-word and vector ≥ 0.30 | 10 | ≥ 0.02 | 0.848 | 0.879 | 1.000 | 0.571 | 0.788 | 0.811 | 0.88 | 0.250 | 0 | 0 | 0 | 2 | 1 | 141.2 | 4 |

## Every configuration on the corpus

| Reranker | Source | Depth | Relevance | Recall@5 | Recall@10 | Exact recall@5 | Paraphrase recall@10 | MRR | nDCG@10 | Non-relevant in top 10 | No-answer returning anything | Obsolete | Exposure | Errors | Duplicates | Fetches | Model p95 (ms) | Conditions failed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17 retrieve | 10 | ≥ 0.01 | 0.909 | 0.909 | 1.000 | 0.714 | 0.909 | 0.909 | 0.61 | 0.500 | 0 | 0 | 0 | 1 | 1 | 68.9 | 2 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17 retrieve | 10 | ≥ 0.02 | 0.909 | 0.909 | 1.000 | 0.714 | 0.909 | 0.909 | 0.52 | 0.250 | 0 | 0 | 0 | 1 | 1 | 68.9 | 2 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17 retrieve | 10 | ≥ 0.05 | 0.909 | 0.909 | 1.000 | 0.714 | 0.909 | 0.909 | 0.48 | 0.250 | 0 | 0 | 0 | 1 | 1 | 68.9 | 2 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17 retrieve | 10 | ≥ 0.1 | 0.879 | 0.879 | 1.000 | 0.571 | 0.879 | 0.879 | 0.45 | 0.250 | 0 | 0 | 0 | 1 | 1 | 68.9 | 4 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17 retrieve | 10 | ≥ 0.2 | 0.879 | 0.879 | 1.000 | 0.571 | 0.879 | 0.879 | 0.42 | 0.250 | 0 | 0 | 0 | 1 | 1 | 68.9 | 4 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17 retrieve | 10 | ≥ 0.3 | 0.879 | 0.879 | 1.000 | 0.571 | 0.879 | 0.879 | 0.36 | 0.250 | 0 | 0 | 0 | 1 | 1 | 68.9 | 4 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17 retrieve | 10 | ≥ 0.5 | 0.848 | 0.848 | 1.000 | 0.429 | 0.848 | 0.848 | 0.30 | 0.250 | 0 | 0 | 0 | 1 | 1 | 68.9 | 4 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17 retrieve | 10 | ≥ 0.7 | 0.848 | 0.848 | 1.000 | 0.429 | 0.848 | 0.848 | 0.24 | 0.250 | 0 | 0 | 0 | 1 | 1 | 68.9 | 4 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17 retrieve | 20 | ≥ 0.01 | 0.909 | 0.909 | 1.000 | 0.714 | 0.909 | 0.909 | 0.61 | 0.500 | 0 | 0 | 0 | 1 | 1 | 32.9 | 1 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17 retrieve | 20 | ≥ 0.02 | 0.909 | 0.909 | 1.000 | 0.714 | 0.909 | 0.909 | 0.52 | 0.250 | 0 | 0 | 0 | 1 | 1 | 32.9 | 1 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17 retrieve | 20 | ≥ 0.05 | 0.909 | 0.909 | 1.000 | 0.714 | 0.909 | 0.909 | 0.48 | 0.250 | 0 | 0 | 0 | 1 | 1 | 32.9 | 1 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17 retrieve | 20 | ≥ 0.1 | 0.879 | 0.879 | 1.000 | 0.571 | 0.879 | 0.879 | 0.45 | 0.250 | 0 | 0 | 0 | 1 | 1 | 32.9 | 3 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17 retrieve | 20 | ≥ 0.2 | 0.879 | 0.879 | 1.000 | 0.571 | 0.879 | 0.879 | 0.42 | 0.250 | 0 | 0 | 0 | 1 | 1 | 32.9 | 3 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17 retrieve | 20 | ≥ 0.3 | 0.879 | 0.879 | 1.000 | 0.571 | 0.879 | 0.879 | 0.36 | 0.250 | 0 | 0 | 0 | 1 | 1 | 32.9 | 3 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17 retrieve | 20 | ≥ 0.5 | 0.848 | 0.848 | 1.000 | 0.429 | 0.848 | 0.848 | 0.30 | 0.250 | 0 | 0 | 0 | 1 | 1 | 32.9 | 3 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17 retrieve | 20 | ≥ 0.7 | 0.848 | 0.848 | 1.000 | 0.429 | 0.848 | 0.848 | 0.24 | 0.250 | 0 | 0 | 0 | 1 | 1 | 32.9 | 3 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17 retrieve | 50 | ≥ 0.01 | 0.909 | 0.909 | 1.000 | 0.714 | 0.909 | 0.909 | 0.61 | 0.500 | 0 | 0 | 0 | 1 | 1 | 18.0 | 1 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17 retrieve | 50 | ≥ 0.02 | 0.909 | 0.909 | 1.000 | 0.714 | 0.909 | 0.909 | 0.52 | 0.250 | 0 | 0 | 0 | 1 | 1 | 18.0 | 1 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17 retrieve | 50 | ≥ 0.05 | 0.909 | 0.909 | 1.000 | 0.714 | 0.909 | 0.909 | 0.48 | 0.250 | 0 | 0 | 0 | 1 | 1 | 18.0 | 1 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17 retrieve | 50 | ≥ 0.1 | 0.879 | 0.879 | 1.000 | 0.571 | 0.879 | 0.879 | 0.45 | 0.250 | 0 | 0 | 0 | 1 | 1 | 18.0 | 3 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17 retrieve | 50 | ≥ 0.2 | 0.879 | 0.879 | 1.000 | 0.571 | 0.879 | 0.879 | 0.42 | 0.250 | 0 | 0 | 0 | 1 | 1 | 18.0 | 3 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17 retrieve | 50 | ≥ 0.3 | 0.879 | 0.879 | 1.000 | 0.571 | 0.879 | 0.879 | 0.36 | 0.250 | 0 | 0 | 0 | 1 | 1 | 18.0 | 3 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17 retrieve | 50 | ≥ 0.5 | 0.848 | 0.848 | 1.000 | 0.429 | 0.848 | 0.848 | 0.30 | 0.250 | 0 | 0 | 0 | 1 | 1 | 18.0 | 3 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17 retrieve | 50 | ≥ 0.7 | 0.848 | 0.848 | 1.000 | 0.429 | 0.848 | 0.848 | 0.24 | 0.250 | 0 | 0 | 0 | 1 | 1 | 18.0 | 3 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17, any-word share | 10 | ≥ 0.01 | 0.909 | 0.909 | 1.000 | 0.714 | 0.909 | 0.909 | 0.82 | 0.500 | 0 | 0 | 0 | 2 | 1 | 1018.8 | 2 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17, any-word share | 10 | ≥ 0.02 | 0.909 | 0.909 | 1.000 | 0.714 | 0.909 | 0.909 | 0.73 | 0.250 | 0 | 0 | 0 | 2 | 1 | 1018.8 | 2 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17, any-word share | 10 | ≥ 0.05 | 0.909 | 0.909 | 1.000 | 0.714 | 0.909 | 0.909 | 0.67 | 0.250 | 0 | 0 | 0 | 2 | 1 | 1018.8 | 2 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17, any-word share | 10 | ≥ 0.1 | 0.879 | 0.879 | 1.000 | 0.571 | 0.879 | 0.879 | 0.61 | 0.250 | 0 | 0 | 0 | 2 | 1 | 1018.8 | 4 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17, any-word share | 10 | ≥ 0.2 | 0.879 | 0.879 | 1.000 | 0.571 | 0.879 | 0.879 | 0.52 | 0.250 | 0 | 0 | 0 | 1 | 1 | 1018.8 | 4 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17, any-word share | 10 | ≥ 0.3 | 0.879 | 0.879 | 1.000 | 0.571 | 0.879 | 0.879 | 0.45 | 0.250 | 0 | 0 | 0 | 1 | 1 | 1018.8 | 4 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17, any-word share | 10 | ≥ 0.5 | 0.848 | 0.848 | 1.000 | 0.429 | 0.848 | 0.848 | 0.39 | 0.250 | 0 | 0 | 0 | 1 | 1 | 1018.8 | 4 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17, any-word share | 10 | ≥ 0.7 | 0.848 | 0.848 | 1.000 | 0.429 | 0.848 | 0.848 | 0.33 | 0.250 | 0 | 0 | 0 | 1 | 1 | 1018.8 | 4 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17, any-word share | 20 | ≥ 0.01 | 0.909 | 0.909 | 1.000 | 0.714 | 0.909 | 0.909 | 0.85 | 0.500 | 0 | 0 | 0 | 2 | 1 | 2161.7 | 2 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17, any-word share | 20 | ≥ 0.02 | 0.909 | 0.909 | 1.000 | 0.714 | 0.909 | 0.909 | 0.76 | 0.250 | 0 | 0 | 0 | 2 | 1 | 2161.7 | 2 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17, any-word share | 20 | ≥ 0.05 | 0.909 | 0.909 | 1.000 | 0.714 | 0.909 | 0.909 | 0.70 | 0.250 | 0 | 0 | 0 | 2 | 1 | 2161.7 | 2 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17, any-word share | 20 | ≥ 0.1 | 0.879 | 0.879 | 1.000 | 0.571 | 0.879 | 0.879 | 0.64 | 0.250 | 0 | 0 | 0 | 2 | 1 | 2161.7 | 4 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17, any-word share | 20 | ≥ 0.2 | 0.879 | 0.879 | 1.000 | 0.571 | 0.879 | 0.879 | 0.55 | 0.250 | 0 | 0 | 0 | 1 | 1 | 2161.7 | 4 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17, any-word share | 20 | ≥ 0.3 | 0.879 | 0.879 | 1.000 | 0.571 | 0.879 | 0.879 | 0.48 | 0.250 | 0 | 0 | 0 | 1 | 1 | 2161.7 | 4 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17, any-word share | 20 | ≥ 0.5 | 0.848 | 0.848 | 1.000 | 0.429 | 0.848 | 0.848 | 0.42 | 0.250 | 0 | 0 | 0 | 1 | 1 | 2161.7 | 4 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17, any-word share | 20 | ≥ 0.7 | 0.848 | 0.848 | 1.000 | 0.429 | 0.848 | 0.848 | 0.36 | 0.250 | 0 | 0 | 0 | 1 | 1 | 2161.7 | 4 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17, any-word share | 50 | ≥ 0.01 | 0.939 | 0.939 | 1.000 | 0.857 | 0.924 | 0.928 | 0.85 | 0.500 | 0 | 0 | 0 | 2 | 1 | 2560.9 | 2 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17, any-word share | 50 | ≥ 0.02 | 0.939 | 0.939 | 1.000 | 0.857 | 0.924 | 0.928 | 0.76 | 0.250 | 0 | 0 | 0 | 2 | 1 | 2560.9 | 2 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17, any-word share | 50 | ≥ 0.05 | 0.939 | 0.939 | 1.000 | 0.857 | 0.924 | 0.928 | 0.70 | 0.250 | 0 | 0 | 0 | 2 | 1 | 2560.9 | 2 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17, any-word share | 50 | ≥ 0.1 | 0.909 | 0.909 | 1.000 | 0.714 | 0.894 | 0.898 | 0.64 | 0.250 | 0 | 0 | 0 | 2 | 1 | 2560.9 | 2 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17, any-word share | 50 | ≥ 0.2 | 0.909 | 0.909 | 1.000 | 0.714 | 0.894 | 0.898 | 0.55 | 0.250 | 0 | 0 | 0 | 1 | 1 | 2560.9 | 2 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17, any-word share | 50 | ≥ 0.3 | 0.909 | 0.909 | 1.000 | 0.714 | 0.894 | 0.898 | 0.48 | 0.250 | 0 | 0 | 0 | 1 | 1 | 2560.9 | 2 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17, any-word share | 50 | ≥ 0.5 | 0.879 | 0.879 | 1.000 | 0.571 | 0.864 | 0.868 | 0.42 | 0.250 | 0 | 0 | 0 | 1 | 1 | 2560.9 | 4 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17, any-word share | 50 | ≥ 0.7 | 0.879 | 0.879 | 1.000 | 0.571 | 0.864 | 0.868 | 0.36 | 0.250 | 0 | 0 | 0 | 1 | 1 | 2560.9 | 4 |
| Xenova/ms-marco-MiniLM-L-6-v2 | RRF of any-word and vector ≥ 0.30 | 10 | ≥ 0.01 | 0.939 | 0.939 | 1.000 | 0.857 | 0.924 | 0.928 | 2.42 | 0.500 | 0 | 0 | 0 | 4 | 1 | 964.8 | 3 |
| Xenova/ms-marco-MiniLM-L-6-v2 | RRF of any-word and vector ≥ 0.30 | 10 | ≥ 0.02 | 0.939 | 0.939 | 1.000 | 0.857 | 0.924 | 0.928 | 2.06 | 0.250 | 0 | 0 | 0 | 3 | 1 | 964.8 | 3 |
| Xenova/ms-marco-MiniLM-L-6-v2 | RRF of any-word and vector ≥ 0.30 | 10 | ≥ 0.05 | 0.939 | 0.939 | 1.000 | 0.857 | 0.924 | 0.928 | 1.58 | 0.250 | 0 | 0 | 0 | 3 | 1 | 964.8 | 2 |
| Xenova/ms-marco-MiniLM-L-6-v2 | RRF of any-word and vector ≥ 0.30 | 10 | ≥ 0.1 | 0.909 | 0.909 | 1.000 | 0.714 | 0.894 | 0.898 | 1.18 | 0.250 | 0 | 0 | 0 | 3 | 1 | 964.8 | 2 |
| Xenova/ms-marco-MiniLM-L-6-v2 | RRF of any-word and vector ≥ 0.30 | 10 | ≥ 0.2 | 0.909 | 0.909 | 1.000 | 0.714 | 0.894 | 0.898 | 0.91 | 0.250 | 0 | 0 | 0 | 2 | 1 | 964.8 | 2 |
| Xenova/ms-marco-MiniLM-L-6-v2 | RRF of any-word and vector ≥ 0.30 | 10 | ≥ 0.3 | 0.909 | 0.909 | 1.000 | 0.714 | 0.894 | 0.898 | 0.73 | 0.250 | 0 | 0 | 0 | 2 | 1 | 964.8 | 2 |
| Xenova/ms-marco-MiniLM-L-6-v2 | RRF of any-word and vector ≥ 0.30 | 10 | ≥ 0.5 | 0.879 | 0.879 | 1.000 | 0.571 | 0.864 | 0.868 | 0.64 | 0.250 | 0 | 0 | 0 | 2 | 1 | 964.8 | 4 |
| Xenova/ms-marco-MiniLM-L-6-v2 | RRF of any-word and vector ≥ 0.30 | 10 | ≥ 0.7 | 0.879 | 0.879 | 1.000 | 0.571 | 0.864 | 0.868 | 0.55 | 0.250 | 0 | 0 | 0 | 2 | 1 | 964.8 | 4 |
| Xenova/ms-marco-MiniLM-L-6-v2 | RRF of any-word and vector ≥ 0.30 | 20 | ≥ 0.01 | 0.939 | 0.939 | 1.000 | 0.857 | 0.924 | 0.928 | 2.85 | 0.500 | 0 | 0 | 0 | 6 | 1 | 2475.8 | 3 |
| Xenova/ms-marco-MiniLM-L-6-v2 | RRF of any-word and vector ≥ 0.30 | 20 | ≥ 0.02 | 0.939 | 0.939 | 1.000 | 0.857 | 0.924 | 0.928 | 2.45 | 0.250 | 0 | 0 | 0 | 5 | 1 | 2475.8 | 3 |
| Xenova/ms-marco-MiniLM-L-6-v2 | RRF of any-word and vector ≥ 0.30 | 20 | ≥ 0.05 | 0.939 | 0.939 | 1.000 | 0.857 | 0.924 | 0.928 | 2.12 | 0.250 | 0 | 0 | 0 | 5 | 1 | 2475.8 | 3 |
| Xenova/ms-marco-MiniLM-L-6-v2 | RRF of any-word and vector ≥ 0.30 | 20 | ≥ 0.1 | 0.909 | 0.909 | 1.000 | 0.714 | 0.894 | 0.898 | 1.45 | 0.250 | 0 | 0 | 0 | 3 | 1 | 2475.8 | 2 |
| Xenova/ms-marco-MiniLM-L-6-v2 | RRF of any-word and vector ≥ 0.30 | 20 | ≥ 0.2 | 0.909 | 0.909 | 1.000 | 0.714 | 0.894 | 0.898 | 1.18 | 0.250 | 0 | 0 | 0 | 2 | 1 | 2475.8 | 2 |
| Xenova/ms-marco-MiniLM-L-6-v2 | RRF of any-word and vector ≥ 0.30 | 20 | ≥ 0.3 | 0.909 | 0.909 | 1.000 | 0.714 | 0.894 | 0.898 | 0.88 | 0.250 | 0 | 0 | 0 | 2 | 1 | 2475.8 | 2 |
| Xenova/ms-marco-MiniLM-L-6-v2 | RRF of any-word and vector ≥ 0.30 | 20 | ≥ 0.5 | 0.879 | 0.879 | 1.000 | 0.571 | 0.864 | 0.868 | 0.70 | 0.250 | 0 | 0 | 0 | 2 | 1 | 2475.8 | 4 |
| Xenova/ms-marco-MiniLM-L-6-v2 | RRF of any-word and vector ≥ 0.30 | 20 | ≥ 0.7 | 0.879 | 0.879 | 1.000 | 0.571 | 0.864 | 0.868 | 0.55 | 0.250 | 0 | 0 | 0 | 2 | 1 | 2475.8 | 4 |
| Xenova/ms-marco-MiniLM-L-6-v2 | RRF of any-word and vector ≥ 0.30 | 50 | ≥ 0.01 | 0.939 | 0.939 | 1.000 | 0.857 | 0.924 | 0.928 | 2.85 | 0.500 | 0 | 0 | 0 | 7 | 1 | 2292.1 | 3 |
| Xenova/ms-marco-MiniLM-L-6-v2 | RRF of any-word and vector ≥ 0.30 | 50 | ≥ 0.02 | 0.939 | 0.939 | 1.000 | 0.857 | 0.924 | 0.928 | 2.45 | 0.250 | 0 | 0 | 0 | 6 | 1 | 2292.1 | 3 |
| Xenova/ms-marco-MiniLM-L-6-v2 | RRF of any-word and vector ≥ 0.30 | 50 | ≥ 0.05 | 0.939 | 0.939 | 1.000 | 0.857 | 0.924 | 0.928 | 2.12 | 0.250 | 0 | 0 | 0 | 6 | 1 | 2292.1 | 3 |
| Xenova/ms-marco-MiniLM-L-6-v2 | RRF of any-word and vector ≥ 0.30 | 50 | ≥ 0.1 | 0.909 | 0.909 | 1.000 | 0.714 | 0.894 | 0.898 | 1.55 | 0.250 | 0 | 0 | 0 | 4 | 1 | 2292.1 | 2 |
| Xenova/ms-marco-MiniLM-L-6-v2 | RRF of any-word and vector ≥ 0.30 | 50 | ≥ 0.2 | 0.909 | 0.909 | 1.000 | 0.714 | 0.894 | 0.898 | 1.21 | 0.250 | 0 | 0 | 0 | 2 | 1 | 2292.1 | 2 |
| Xenova/ms-marco-MiniLM-L-6-v2 | RRF of any-word and vector ≥ 0.30 | 50 | ≥ 0.3 | 0.909 | 0.909 | 1.000 | 0.714 | 0.894 | 0.898 | 0.91 | 0.250 | 0 | 0 | 0 | 2 | 1 | 2292.1 | 2 |
| Xenova/ms-marco-MiniLM-L-6-v2 | RRF of any-word and vector ≥ 0.30 | 50 | ≥ 0.5 | 0.879 | 0.879 | 1.000 | 0.571 | 0.864 | 0.868 | 0.70 | 0.250 | 0 | 0 | 0 | 2 | 1 | 2292.1 | 4 |
| Xenova/ms-marco-MiniLM-L-6-v2 | RRF of any-word and vector ≥ 0.30 | 50 | ≥ 0.7 | 0.879 | 0.879 | 1.000 | 0.571 | 0.864 | 0.868 | 0.55 | 0.250 | 0 | 0 | 0 | 2 | 1 | 2292.1 | 4 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17 retrieve | 10 | ≥ 0.01 | 0.848 | 0.848 | 1.000 | 0.429 | 0.783 | 0.800 | 0.45 | 0.250 | 0 | 0 | 0 | 1 | 1 | 3.28 | 3 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17 retrieve | 10 | ≥ 0.02 | 0.848 | 0.848 | 1.000 | 0.429 | 0.783 | 0.800 | 0.42 | 0.250 | 0 | 0 | 0 | 1 | 1 | 3.28 | 3 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17 retrieve | 10 | ≥ 0.05 | 0.848 | 0.848 | 1.000 | 0.429 | 0.783 | 0.800 | 0.42 | 0.250 | 0 | 0 | 0 | 1 | 1 | 3.28 | 3 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17 retrieve | 10 | ≥ 0.1 | 0.818 | 0.818 | 1.000 | 0.286 | 0.753 | 0.769 | 0.42 | 0.250 | 0 | 0 | 0 | 1 | 1 | 3.28 | 3 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17 retrieve | 10 | ≥ 0.2 | 0.788 | 0.788 | 1.000 | 0.143 | 0.742 | 0.754 | 0.39 | 0.250 | 0 | 0 | 0 | 1 | 1 | 3.28 | 4 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17 retrieve | 10 | ≥ 0.3 | 0.788 | 0.788 | 1.000 | 0.143 | 0.742 | 0.754 | 0.39 | 0.250 | 0 | 0 | 0 | 1 | 1 | 3.28 | 4 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17 retrieve | 10 | ≥ 0.5 | 0.788 | 0.788 | 1.000 | 0.143 | 0.742 | 0.754 | 0.39 | 0.250 | 0 | 0 | 0 | 1 | 1 | 3.28 | 4 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17 retrieve | 10 | ≥ 0.7 | 0.788 | 0.788 | 1.000 | 0.143 | 0.742 | 0.754 | 0.36 | 0.250 | 0 | 0 | 0 | 1 | 1 | 3.28 | 4 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17 retrieve | 20 | ≥ 0.01 | 0.848 | 0.848 | 1.000 | 0.429 | 0.783 | 0.800 | 0.45 | 0.250 | 0 | 0 | 0 | 1 | 1 | 1.71 | 3 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17 retrieve | 20 | ≥ 0.02 | 0.848 | 0.848 | 1.000 | 0.429 | 0.783 | 0.800 | 0.42 | 0.250 | 0 | 0 | 0 | 1 | 1 | 1.71 | 3 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17 retrieve | 20 | ≥ 0.05 | 0.848 | 0.848 | 1.000 | 0.429 | 0.783 | 0.800 | 0.42 | 0.250 | 0 | 0 | 0 | 1 | 1 | 1.71 | 3 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17 retrieve | 20 | ≥ 0.1 | 0.818 | 0.818 | 1.000 | 0.286 | 0.753 | 0.769 | 0.42 | 0.250 | 0 | 0 | 0 | 1 | 1 | 1.71 | 3 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17 retrieve | 20 | ≥ 0.2 | 0.788 | 0.788 | 1.000 | 0.143 | 0.742 | 0.754 | 0.39 | 0.250 | 0 | 0 | 0 | 1 | 1 | 1.71 | 4 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17 retrieve | 20 | ≥ 0.3 | 0.788 | 0.788 | 1.000 | 0.143 | 0.742 | 0.754 | 0.39 | 0.250 | 0 | 0 | 0 | 1 | 1 | 1.71 | 4 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17 retrieve | 20 | ≥ 0.5 | 0.788 | 0.788 | 1.000 | 0.143 | 0.742 | 0.754 | 0.39 | 0.250 | 0 | 0 | 0 | 1 | 1 | 1.71 | 4 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17 retrieve | 20 | ≥ 0.7 | 0.788 | 0.788 | 1.000 | 0.143 | 0.742 | 0.754 | 0.36 | 0.250 | 0 | 0 | 0 | 1 | 1 | 1.71 | 4 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17 retrieve | 50 | ≥ 0.01 | 0.848 | 0.848 | 1.000 | 0.429 | 0.783 | 0.800 | 0.45 | 0.250 | 0 | 0 | 0 | 1 | 1 | 1.49 | 3 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17 retrieve | 50 | ≥ 0.02 | 0.848 | 0.848 | 1.000 | 0.429 | 0.783 | 0.800 | 0.42 | 0.250 | 0 | 0 | 0 | 1 | 1 | 1.49 | 3 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17 retrieve | 50 | ≥ 0.05 | 0.848 | 0.848 | 1.000 | 0.429 | 0.783 | 0.800 | 0.42 | 0.250 | 0 | 0 | 0 | 1 | 1 | 1.49 | 3 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17 retrieve | 50 | ≥ 0.1 | 0.818 | 0.818 | 1.000 | 0.286 | 0.753 | 0.769 | 0.42 | 0.250 | 0 | 0 | 0 | 1 | 1 | 1.49 | 3 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17 retrieve | 50 | ≥ 0.2 | 0.788 | 0.788 | 1.000 | 0.143 | 0.742 | 0.754 | 0.39 | 0.250 | 0 | 0 | 0 | 1 | 1 | 1.49 | 4 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17 retrieve | 50 | ≥ 0.3 | 0.788 | 0.788 | 1.000 | 0.143 | 0.742 | 0.754 | 0.39 | 0.250 | 0 | 0 | 0 | 1 | 1 | 1.49 | 4 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17 retrieve | 50 | ≥ 0.5 | 0.788 | 0.788 | 1.000 | 0.143 | 0.742 | 0.754 | 0.39 | 0.250 | 0 | 0 | 0 | 1 | 1 | 1.49 | 4 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17 retrieve | 50 | ≥ 0.7 | 0.788 | 0.788 | 1.000 | 0.143 | 0.742 | 0.754 | 0.36 | 0.250 | 0 | 0 | 0 | 1 | 1 | 1.49 | 4 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17, any-word share | 10 | ≥ 0.01 | 0.848 | 0.848 | 1.000 | 0.429 | 0.783 | 0.800 | 0.64 | 0.250 | 0 | 0 | 0 | 2 | 1 | 91.2 | 4 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17, any-word share | 10 | ≥ 0.02 | 0.848 | 0.848 | 1.000 | 0.429 | 0.783 | 0.800 | 0.58 | 0.250 | 0 | 0 | 0 | 2 | 1 | 91.2 | 4 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17, any-word share | 10 | ≥ 0.05 | 0.848 | 0.848 | 1.000 | 0.429 | 0.783 | 0.800 | 0.58 | 0.250 | 0 | 0 | 0 | 2 | 1 | 91.2 | 4 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17, any-word share | 10 | ≥ 0.1 | 0.818 | 0.818 | 1.000 | 0.286 | 0.753 | 0.769 | 0.55 | 0.250 | 0 | 0 | 0 | 2 | 1 | 91.2 | 4 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17, any-word share | 10 | ≥ 0.2 | 0.788 | 0.788 | 1.000 | 0.143 | 0.742 | 0.754 | 0.45 | 0.250 | 0 | 0 | 0 | 1 | 1 | 91.2 | 5 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17, any-word share | 10 | ≥ 0.3 | 0.788 | 0.788 | 1.000 | 0.143 | 0.742 | 0.754 | 0.39 | 0.250 | 0 | 0 | 0 | 1 | 1 | 91.2 | 5 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17, any-word share | 10 | ≥ 0.5 | 0.788 | 0.788 | 1.000 | 0.143 | 0.742 | 0.754 | 0.39 | 0.250 | 0 | 0 | 0 | 1 | 1 | 91.2 | 5 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17, any-word share | 10 | ≥ 0.7 | 0.788 | 0.788 | 1.000 | 0.143 | 0.742 | 0.754 | 0.36 | 0.250 | 0 | 0 | 0 | 1 | 1 | 91.2 | 5 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17, any-word share | 20 | ≥ 0.01 | 0.848 | 0.848 | 1.000 | 0.429 | 0.783 | 0.800 | 0.67 | 0.250 | 0 | 0 | 0 | 2 | 1 | 126.8 | 4 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17, any-word share | 20 | ≥ 0.02 | 0.848 | 0.848 | 1.000 | 0.429 | 0.783 | 0.800 | 0.61 | 0.250 | 0 | 0 | 0 | 2 | 1 | 126.8 | 4 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17, any-word share | 20 | ≥ 0.05 | 0.848 | 0.848 | 1.000 | 0.429 | 0.783 | 0.800 | 0.61 | 0.250 | 0 | 0 | 0 | 2 | 1 | 126.8 | 4 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17, any-word share | 20 | ≥ 0.1 | 0.818 | 0.818 | 1.000 | 0.286 | 0.753 | 0.769 | 0.58 | 0.250 | 0 | 0 | 0 | 2 | 1 | 126.8 | 4 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17, any-word share | 20 | ≥ 0.2 | 0.788 | 0.788 | 1.000 | 0.143 | 0.742 | 0.754 | 0.48 | 0.250 | 0 | 0 | 0 | 1 | 1 | 126.8 | 5 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17, any-word share | 20 | ≥ 0.3 | 0.788 | 0.788 | 1.000 | 0.143 | 0.742 | 0.754 | 0.42 | 0.250 | 0 | 0 | 0 | 1 | 1 | 126.8 | 5 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17, any-word share | 20 | ≥ 0.5 | 0.788 | 0.788 | 1.000 | 0.143 | 0.742 | 0.754 | 0.42 | 0.250 | 0 | 0 | 0 | 1 | 1 | 126.8 | 5 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17, any-word share | 20 | ≥ 0.7 | 0.788 | 0.788 | 1.000 | 0.143 | 0.742 | 0.754 | 0.36 | 0.250 | 0 | 0 | 0 | 1 | 1 | 126.8 | 5 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17, any-word share | 50 | ≥ 0.01 | 0.848 | 0.879 | 1.000 | 0.571 | 0.788 | 0.811 | 0.67 | 0.250 | 0 | 0 | 0 | 2 | 1 | 160.0 | 4 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17, any-word share | 50 | ≥ 0.02 | 0.848 | 0.879 | 1.000 | 0.571 | 0.788 | 0.811 | 0.61 | 0.250 | 0 | 0 | 0 | 2 | 1 | 160.0 | 4 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17, any-word share | 50 | ≥ 0.05 | 0.848 | 0.848 | 1.000 | 0.429 | 0.783 | 0.800 | 0.61 | 0.250 | 0 | 0 | 0 | 2 | 1 | 160.0 | 4 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17, any-word share | 50 | ≥ 0.1 | 0.818 | 0.818 | 1.000 | 0.286 | 0.753 | 0.769 | 0.58 | 0.250 | 0 | 0 | 0 | 2 | 1 | 160.0 | 4 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17, any-word share | 50 | ≥ 0.2 | 0.788 | 0.788 | 1.000 | 0.143 | 0.742 | 0.754 | 0.48 | 0.250 | 0 | 0 | 0 | 1 | 1 | 160.0 | 5 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17, any-word share | 50 | ≥ 0.3 | 0.788 | 0.788 | 1.000 | 0.143 | 0.742 | 0.754 | 0.42 | 0.250 | 0 | 0 | 0 | 1 | 1 | 160.0 | 5 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17, any-word share | 50 | ≥ 0.5 | 0.788 | 0.788 | 1.000 | 0.143 | 0.742 | 0.754 | 0.42 | 0.250 | 0 | 0 | 0 | 1 | 1 | 160.0 | 5 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17, any-word share | 50 | ≥ 0.7 | 0.788 | 0.788 | 1.000 | 0.143 | 0.742 | 0.754 | 0.36 | 0.250 | 0 | 0 | 0 | 1 | 1 | 160.0 | 5 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | RRF of any-word and vector ≥ 0.30 | 10 | ≥ 0.01 | 0.848 | 0.879 | 1.000 | 0.571 | 0.788 | 0.811 | 1.06 | 0.250 | 0 | 0 | 0 | 2 | 1 | 141.2 | 4 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | RRF of any-word and vector ≥ 0.30 | 10 | ≥ 0.02 | 0.848 | 0.879 | 1.000 | 0.571 | 0.788 | 0.811 | 0.88 | 0.250 | 0 | 0 | 0 | 2 | 1 | 141.2 | 4 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | RRF of any-word and vector ≥ 0.30 | 10 | ≥ 0.05 | 0.848 | 0.848 | 1.000 | 0.429 | 0.783 | 0.800 | 0.79 | 0.250 | 0 | 0 | 0 | 2 | 1 | 141.2 | 4 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | RRF of any-word and vector ≥ 0.30 | 10 | ≥ 0.1 | 0.818 | 0.818 | 1.000 | 0.286 | 0.753 | 0.769 | 0.70 | 0.250 | 0 | 0 | 0 | 2 | 1 | 141.2 | 4 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | RRF of any-word and vector ≥ 0.30 | 10 | ≥ 0.2 | 0.788 | 0.788 | 1.000 | 0.143 | 0.742 | 0.754 | 0.61 | 0.250 | 0 | 0 | 0 | 1 | 1 | 141.2 | 5 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | RRF of any-word and vector ≥ 0.30 | 10 | ≥ 0.3 | 0.788 | 0.788 | 1.000 | 0.143 | 0.742 | 0.754 | 0.52 | 0.250 | 0 | 0 | 0 | 1 | 1 | 141.2 | 5 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | RRF of any-word and vector ≥ 0.30 | 10 | ≥ 0.5 | 0.788 | 0.788 | 1.000 | 0.143 | 0.742 | 0.754 | 0.52 | 0.250 | 0 | 0 | 0 | 1 | 1 | 141.2 | 5 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | RRF of any-word and vector ≥ 0.30 | 10 | ≥ 0.7 | 0.788 | 0.788 | 1.000 | 0.143 | 0.742 | 0.754 | 0.39 | 0.250 | 0 | 0 | 0 | 1 | 1 | 141.2 | 5 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | RRF of any-word and vector ≥ 0.30 | 20 | ≥ 0.01 | 0.848 | 0.879 | 1.000 | 0.571 | 0.785 | 0.808 | 1.55 | 0.250 | 0 | 0 | 0 | 2 | 1 | 252.7 | 4 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | RRF of any-word and vector ≥ 0.30 | 20 | ≥ 0.02 | 0.848 | 0.879 | 1.000 | 0.571 | 0.785 | 0.808 | 1.33 | 0.250 | 0 | 0 | 0 | 2 | 1 | 252.7 | 4 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | RRF of any-word and vector ≥ 0.30 | 20 | ≥ 0.05 | 0.848 | 0.848 | 1.000 | 0.429 | 0.780 | 0.798 | 1.12 | 0.250 | 0 | 0 | 0 | 2 | 1 | 252.7 | 4 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | RRF of any-word and vector ≥ 0.30 | 20 | ≥ 0.1 | 0.818 | 0.818 | 1.000 | 0.286 | 0.750 | 0.767 | 0.91 | 0.250 | 0 | 0 | 0 | 2 | 1 | 252.7 | 4 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | RRF of any-word and vector ≥ 0.30 | 20 | ≥ 0.2 | 0.788 | 0.788 | 1.000 | 0.143 | 0.742 | 0.754 | 0.79 | 0.250 | 0 | 0 | 0 | 1 | 1 | 252.7 | 5 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | RRF of any-word and vector ≥ 0.30 | 20 | ≥ 0.3 | 0.788 | 0.788 | 1.000 | 0.143 | 0.742 | 0.754 | 0.67 | 0.250 | 0 | 0 | 0 | 1 | 1 | 252.7 | 5 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | RRF of any-word and vector ≥ 0.30 | 20 | ≥ 0.5 | 0.788 | 0.788 | 1.000 | 0.143 | 0.742 | 0.754 | 0.58 | 0.250 | 0 | 0 | 0 | 1 | 1 | 252.7 | 5 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | RRF of any-word and vector ≥ 0.30 | 20 | ≥ 0.7 | 0.788 | 0.788 | 1.000 | 0.143 | 0.742 | 0.754 | 0.42 | 0.250 | 0 | 0 | 0 | 1 | 1 | 252.7 | 5 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | RRF of any-word and vector ≥ 0.30 | 50 | ≥ 0.01 | 0.848 | 0.879 | 1.000 | 0.571 | 0.785 | 0.808 | 1.67 | 0.250 | 0 | 0 | 0 | 2 | 1 | 274.9 | 4 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | RRF of any-word and vector ≥ 0.30 | 50 | ≥ 0.02 | 0.848 | 0.879 | 1.000 | 0.571 | 0.785 | 0.808 | 1.45 | 0.250 | 0 | 0 | 0 | 2 | 1 | 274.9 | 4 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | RRF of any-word and vector ≥ 0.30 | 50 | ≥ 0.05 | 0.848 | 0.848 | 1.000 | 0.429 | 0.780 | 0.798 | 1.21 | 0.250 | 0 | 0 | 0 | 2 | 1 | 274.9 | 4 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | RRF of any-word and vector ≥ 0.30 | 50 | ≥ 0.1 | 0.818 | 0.818 | 1.000 | 0.286 | 0.750 | 0.767 | 0.97 | 0.250 | 0 | 0 | 0 | 2 | 1 | 274.9 | 4 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | RRF of any-word and vector ≥ 0.30 | 50 | ≥ 0.2 | 0.788 | 0.788 | 1.000 | 0.143 | 0.742 | 0.754 | 0.79 | 0.250 | 0 | 0 | 0 | 1 | 1 | 274.9 | 5 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | RRF of any-word and vector ≥ 0.30 | 50 | ≥ 0.3 | 0.788 | 0.788 | 1.000 | 0.143 | 0.742 | 0.754 | 0.67 | 0.250 | 0 | 0 | 0 | 1 | 1 | 274.9 | 5 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | RRF of any-word and vector ≥ 0.30 | 50 | ≥ 0.5 | 0.788 | 0.788 | 1.000 | 0.143 | 0.742 | 0.754 | 0.58 | 0.250 | 0 | 0 | 0 | 1 | 1 | 274.9 | 5 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | RRF of any-word and vector ≥ 0.30 | 50 | ≥ 0.7 | 0.788 | 0.788 | 1.000 | 0.143 | 0.742 | 0.754 | 0.42 | 0.250 | 0 | 0 | 0 | 1 | 1 | 274.9 | 5 |

## Every configuration on heldout.json

| Reranker | Source | Depth | Relevance | Recall@5 | Recall@10 | Exact recall@5 | Paraphrase recall@10 | MRR | nDCG@10 | Non-relevant in top 10 | No-answer returning anything | Obsolete | Exposure | Errors | Duplicates | Fetches | Model p95 (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17 retrieve | 10 | ≥ 0.01 | 0.944 | 0.944 | — | 1.000 | 0.944 | 0.944 | 0.33 | 0.500 | 0 | 0 | 0 | 0 | 0 | 68.9 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17 retrieve | 10 | ≥ 0.02 | 0.944 | 0.944 | — | 1.000 | 0.944 | 0.944 | 0.33 | 0.500 | 0 | 0 | 0 | 0 | 0 | 68.9 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17 retrieve | 10 | ≥ 0.05 | 0.944 | 0.944 | — | 1.000 | 0.944 | 0.944 | 0.33 | 0.500 | 0 | 0 | 0 | 0 | 0 | 68.9 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17 retrieve | 10 | ≥ 0.1 | 0.944 | 0.944 | — | 1.000 | 0.944 | 0.944 | 0.33 | 0.500 | 0 | 0 | 0 | 0 | 0 | 68.9 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17 retrieve | 10 | ≥ 0.2 | 0.944 | 0.944 | — | 1.000 | 0.944 | 0.944 | 0.28 | 0.500 | 0 | 0 | 0 | 0 | 0 | 68.9 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17 retrieve | 10 | ≥ 0.3 | 0.944 | 0.944 | — | 1.000 | 0.944 | 0.944 | 0.11 | 0.500 | 0 | 0 | 0 | 0 | 0 | 68.9 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17 retrieve | 10 | ≥ 0.5 | 0.944 | 0.944 | — | 1.000 | 0.944 | 0.944 | 0.11 | 0.500 | 0 | 0 | 0 | 0 | 0 | 68.9 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17 retrieve | 10 | ≥ 0.7 | 0.944 | 0.944 | — | 1.000 | 0.944 | 0.944 | 0.06 | 0.500 | 0 | 0 | 0 | 0 | 0 | 68.9 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17 retrieve | 20 | ≥ 0.01 | 0.944 | 0.944 | — | 1.000 | 0.944 | 0.944 | 0.33 | 0.500 | 0 | 0 | 0 | 0 | 0 | 32.9 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17 retrieve | 20 | ≥ 0.02 | 0.944 | 0.944 | — | 1.000 | 0.944 | 0.944 | 0.33 | 0.500 | 0 | 0 | 0 | 0 | 0 | 32.9 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17 retrieve | 20 | ≥ 0.05 | 0.944 | 0.944 | — | 1.000 | 0.944 | 0.944 | 0.33 | 0.500 | 0 | 0 | 0 | 0 | 0 | 32.9 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17 retrieve | 20 | ≥ 0.1 | 0.944 | 0.944 | — | 1.000 | 0.944 | 0.944 | 0.33 | 0.500 | 0 | 0 | 0 | 0 | 0 | 32.9 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17 retrieve | 20 | ≥ 0.2 | 0.944 | 0.944 | — | 1.000 | 0.944 | 0.944 | 0.28 | 0.500 | 0 | 0 | 0 | 0 | 0 | 32.9 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17 retrieve | 20 | ≥ 0.3 | 0.944 | 0.944 | — | 1.000 | 0.944 | 0.944 | 0.11 | 0.500 | 0 | 0 | 0 | 0 | 0 | 32.9 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17 retrieve | 20 | ≥ 0.5 | 0.944 | 0.944 | — | 1.000 | 0.944 | 0.944 | 0.11 | 0.500 | 0 | 0 | 0 | 0 | 0 | 32.9 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17 retrieve | 20 | ≥ 0.7 | 0.944 | 0.944 | — | 1.000 | 0.944 | 0.944 | 0.06 | 0.500 | 0 | 0 | 0 | 0 | 0 | 32.9 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17 retrieve | 50 | ≥ 0.01 | 0.944 | 0.944 | — | 1.000 | 0.944 | 0.944 | 0.33 | 0.500 | 0 | 0 | 0 | 0 | 0 | 18.0 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17 retrieve | 50 | ≥ 0.02 | 0.944 | 0.944 | — | 1.000 | 0.944 | 0.944 | 0.33 | 0.500 | 0 | 0 | 0 | 0 | 0 | 18.0 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17 retrieve | 50 | ≥ 0.05 | 0.944 | 0.944 | — | 1.000 | 0.944 | 0.944 | 0.33 | 0.500 | 0 | 0 | 0 | 0 | 0 | 18.0 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17 retrieve | 50 | ≥ 0.1 | 0.944 | 0.944 | — | 1.000 | 0.944 | 0.944 | 0.33 | 0.500 | 0 | 0 | 0 | 0 | 0 | 18.0 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17 retrieve | 50 | ≥ 0.2 | 0.944 | 0.944 | — | 1.000 | 0.944 | 0.944 | 0.28 | 0.500 | 0 | 0 | 0 | 0 | 0 | 18.0 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17 retrieve | 50 | ≥ 0.3 | 0.944 | 0.944 | — | 1.000 | 0.944 | 0.944 | 0.11 | 0.500 | 0 | 0 | 0 | 0 | 0 | 18.0 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17 retrieve | 50 | ≥ 0.5 | 0.944 | 0.944 | — | 1.000 | 0.944 | 0.944 | 0.11 | 0.500 | 0 | 0 | 0 | 0 | 0 | 18.0 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17 retrieve | 50 | ≥ 0.7 | 0.944 | 0.944 | — | 1.000 | 0.944 | 0.944 | 0.06 | 0.500 | 0 | 0 | 0 | 0 | 0 | 18.0 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17, any-word share | 10 | ≥ 0.01 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.67 | 0.750 | 0 | 0 | 0 | 0 | 0 | 1018.8 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17, any-word share | 10 | ≥ 0.02 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.67 | 0.750 | 0 | 0 | 0 | 0 | 0 | 1018.8 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17, any-word share | 10 | ≥ 0.05 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.61 | 0.750 | 0 | 0 | 0 | 0 | 0 | 1018.8 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17, any-word share | 10 | ≥ 0.1 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.56 | 0.750 | 0 | 0 | 0 | 0 | 0 | 1018.8 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17, any-word share | 10 | ≥ 0.2 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.44 | 0.750 | 0 | 0 | 0 | 0 | 0 | 1018.8 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17, any-word share | 10 | ≥ 0.3 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.28 | 0.500 | 0 | 0 | 0 | 0 | 0 | 1018.8 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17, any-word share | 10 | ≥ 0.5 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.28 | 0.500 | 0 | 0 | 0 | 0 | 0 | 1018.8 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17, any-word share | 10 | ≥ 0.7 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.17 | 0.500 | 0 | 0 | 0 | 0 | 0 | 1018.8 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17, any-word share | 20 | ≥ 0.01 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.67 | 0.750 | 0 | 0 | 0 | 0 | 0 | 2161.7 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17, any-word share | 20 | ≥ 0.02 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.67 | 0.750 | 0 | 0 | 0 | 0 | 0 | 2161.7 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17, any-word share | 20 | ≥ 0.05 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.61 | 0.750 | 0 | 0 | 0 | 0 | 0 | 2161.7 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17, any-word share | 20 | ≥ 0.1 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.56 | 0.750 | 0 | 0 | 0 | 0 | 0 | 2161.7 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17, any-word share | 20 | ≥ 0.2 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.44 | 0.750 | 0 | 0 | 0 | 0 | 0 | 2161.7 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17, any-word share | 20 | ≥ 0.3 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.28 | 0.500 | 0 | 0 | 0 | 0 | 0 | 2161.7 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17, any-word share | 20 | ≥ 0.5 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.28 | 0.500 | 0 | 0 | 0 | 0 | 0 | 2161.7 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17, any-word share | 20 | ≥ 0.7 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.17 | 0.500 | 0 | 0 | 0 | 0 | 0 | 2161.7 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17, any-word share | 50 | ≥ 0.01 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.67 | 0.750 | 0 | 0 | 0 | 0 | 0 | 2560.9 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17, any-word share | 50 | ≥ 0.02 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.67 | 0.750 | 0 | 0 | 0 | 0 | 0 | 2560.9 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17, any-word share | 50 | ≥ 0.05 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.61 | 0.750 | 0 | 0 | 0 | 0 | 0 | 2560.9 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17, any-word share | 50 | ≥ 0.1 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.56 | 0.750 | 0 | 0 | 0 | 0 | 0 | 2560.9 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17, any-word share | 50 | ≥ 0.2 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.44 | 0.750 | 0 | 0 | 0 | 0 | 0 | 2560.9 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17, any-word share | 50 | ≥ 0.3 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.28 | 0.500 | 0 | 0 | 0 | 0 | 0 | 2560.9 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17, any-word share | 50 | ≥ 0.5 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.28 | 0.500 | 0 | 0 | 0 | 0 | 0 | 2560.9 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17, any-word share | 50 | ≥ 0.7 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.17 | 0.500 | 0 | 0 | 0 | 0 | 0 | 2560.9 |
| Xenova/ms-marco-MiniLM-L-6-v2 | RRF of any-word and vector ≥ 0.30 | 10 | ≥ 0.01 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 1.83 | 0.750 | 0 | 0 | 0 | 1 | 0 | 964.8 |
| Xenova/ms-marco-MiniLM-L-6-v2 | RRF of any-word and vector ≥ 0.30 | 10 | ≥ 0.02 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 1.61 | 0.750 | 0 | 0 | 0 | 1 | 0 | 964.8 |
| Xenova/ms-marco-MiniLM-L-6-v2 | RRF of any-word and vector ≥ 0.30 | 10 | ≥ 0.05 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 1.39 | 0.750 | 0 | 0 | 0 | 1 | 0 | 964.8 |
| Xenova/ms-marco-MiniLM-L-6-v2 | RRF of any-word and vector ≥ 0.30 | 10 | ≥ 0.1 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 1.06 | 0.750 | 0 | 0 | 0 | 1 | 0 | 964.8 |
| Xenova/ms-marco-MiniLM-L-6-v2 | RRF of any-word and vector ≥ 0.30 | 10 | ≥ 0.2 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.78 | 0.750 | 0 | 0 | 0 | 0 | 0 | 964.8 |
| Xenova/ms-marco-MiniLM-L-6-v2 | RRF of any-word and vector ≥ 0.30 | 10 | ≥ 0.3 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.50 | 0.500 | 0 | 0 | 0 | 0 | 0 | 964.8 |
| Xenova/ms-marco-MiniLM-L-6-v2 | RRF of any-word and vector ≥ 0.30 | 10 | ≥ 0.5 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.50 | 0.500 | 0 | 0 | 0 | 0 | 0 | 964.8 |
| Xenova/ms-marco-MiniLM-L-6-v2 | RRF of any-word and vector ≥ 0.30 | 10 | ≥ 0.7 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.28 | 0.500 | 0 | 0 | 0 | 0 | 0 | 964.8 |
| Xenova/ms-marco-MiniLM-L-6-v2 | RRF of any-word and vector ≥ 0.30 | 20 | ≥ 0.01 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 2.06 | 0.750 | 0 | 0 | 0 | 2 | 0 | 2475.8 |
| Xenova/ms-marco-MiniLM-L-6-v2 | RRF of any-word and vector ≥ 0.30 | 20 | ≥ 0.02 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 1.72 | 0.750 | 0 | 0 | 0 | 2 | 0 | 2475.8 |
| Xenova/ms-marco-MiniLM-L-6-v2 | RRF of any-word and vector ≥ 0.30 | 20 | ≥ 0.05 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 1.44 | 0.750 | 0 | 0 | 0 | 2 | 0 | 2475.8 |
| Xenova/ms-marco-MiniLM-L-6-v2 | RRF of any-word and vector ≥ 0.30 | 20 | ≥ 0.1 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 1.06 | 0.750 | 0 | 0 | 0 | 1 | 0 | 2475.8 |
| Xenova/ms-marco-MiniLM-L-6-v2 | RRF of any-word and vector ≥ 0.30 | 20 | ≥ 0.2 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.78 | 0.750 | 0 | 0 | 0 | 0 | 0 | 2475.8 |
| Xenova/ms-marco-MiniLM-L-6-v2 | RRF of any-word and vector ≥ 0.30 | 20 | ≥ 0.3 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.50 | 0.500 | 0 | 0 | 0 | 0 | 0 | 2475.8 |
| Xenova/ms-marco-MiniLM-L-6-v2 | RRF of any-word and vector ≥ 0.30 | 20 | ≥ 0.5 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.50 | 0.500 | 0 | 0 | 0 | 0 | 0 | 2475.8 |
| Xenova/ms-marco-MiniLM-L-6-v2 | RRF of any-word and vector ≥ 0.30 | 20 | ≥ 0.7 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.28 | 0.500 | 0 | 0 | 0 | 0 | 0 | 2475.8 |
| Xenova/ms-marco-MiniLM-L-6-v2 | RRF of any-word and vector ≥ 0.30 | 50 | ≥ 0.01 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 2.06 | 0.750 | 0 | 0 | 0 | 2 | 0 | 2292.1 |
| Xenova/ms-marco-MiniLM-L-6-v2 | RRF of any-word and vector ≥ 0.30 | 50 | ≥ 0.02 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 1.72 | 0.750 | 0 | 0 | 0 | 2 | 0 | 2292.1 |
| Xenova/ms-marco-MiniLM-L-6-v2 | RRF of any-word and vector ≥ 0.30 | 50 | ≥ 0.05 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 1.44 | 0.750 | 0 | 0 | 0 | 2 | 0 | 2292.1 |
| Xenova/ms-marco-MiniLM-L-6-v2 | RRF of any-word and vector ≥ 0.30 | 50 | ≥ 0.1 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 1.06 | 0.750 | 0 | 0 | 0 | 1 | 0 | 2292.1 |
| Xenova/ms-marco-MiniLM-L-6-v2 | RRF of any-word and vector ≥ 0.30 | 50 | ≥ 0.2 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.78 | 0.750 | 0 | 0 | 0 | 0 | 0 | 2292.1 |
| Xenova/ms-marco-MiniLM-L-6-v2 | RRF of any-word and vector ≥ 0.30 | 50 | ≥ 0.3 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.50 | 0.500 | 0 | 0 | 0 | 0 | 0 | 2292.1 |
| Xenova/ms-marco-MiniLM-L-6-v2 | RRF of any-word and vector ≥ 0.30 | 50 | ≥ 0.5 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.50 | 0.500 | 0 | 0 | 0 | 0 | 0 | 2292.1 |
| Xenova/ms-marco-MiniLM-L-6-v2 | RRF of any-word and vector ≥ 0.30 | 50 | ≥ 0.7 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.28 | 0.500 | 0 | 0 | 0 | 0 | 0 | 2292.1 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17 retrieve | 10 | ≥ 0.01 | 0.944 | 0.944 | — | 1.000 | 0.944 | 0.944 | 0.22 | 0.500 | 0 | 0 | 0 | 0 | 0 | 3.28 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17 retrieve | 10 | ≥ 0.02 | 0.944 | 0.944 | — | 1.000 | 0.944 | 0.944 | 0.22 | 0.500 | 0 | 0 | 0 | 0 | 0 | 3.28 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17 retrieve | 10 | ≥ 0.05 | 0.944 | 0.944 | — | 1.000 | 0.944 | 0.944 | 0.17 | 0.250 | 0 | 0 | 0 | 0 | 0 | 3.28 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17 retrieve | 10 | ≥ 0.1 | 0.944 | 0.944 | — | 1.000 | 0.944 | 0.944 | 0.17 | 0.250 | 0 | 0 | 0 | 0 | 0 | 3.28 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17 retrieve | 10 | ≥ 0.2 | 0.944 | 0.944 | — | 1.000 | 0.944 | 0.944 | 0.17 | 0.250 | 0 | 0 | 0 | 0 | 0 | 3.28 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17 retrieve | 10 | ≥ 0.3 | 0.944 | 0.944 | — | 1.000 | 0.944 | 0.944 | 0.17 | 0.250 | 0 | 0 | 0 | 0 | 0 | 3.28 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17 retrieve | 10 | ≥ 0.5 | 0.944 | 0.944 | — | 1.000 | 0.944 | 0.944 | 0.17 | 0.250 | 0 | 0 | 0 | 0 | 0 | 3.28 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17 retrieve | 10 | ≥ 0.7 | 0.944 | 0.944 | — | 1.000 | 0.944 | 0.944 | 0.17 | 0.250 | 0 | 0 | 0 | 0 | 0 | 3.28 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17 retrieve | 20 | ≥ 0.01 | 0.944 | 0.944 | — | 1.000 | 0.944 | 0.944 | 0.22 | 0.500 | 0 | 0 | 0 | 0 | 0 | 1.71 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17 retrieve | 20 | ≥ 0.02 | 0.944 | 0.944 | — | 1.000 | 0.944 | 0.944 | 0.22 | 0.500 | 0 | 0 | 0 | 0 | 0 | 1.71 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17 retrieve | 20 | ≥ 0.05 | 0.944 | 0.944 | — | 1.000 | 0.944 | 0.944 | 0.17 | 0.250 | 0 | 0 | 0 | 0 | 0 | 1.71 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17 retrieve | 20 | ≥ 0.1 | 0.944 | 0.944 | — | 1.000 | 0.944 | 0.944 | 0.17 | 0.250 | 0 | 0 | 0 | 0 | 0 | 1.71 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17 retrieve | 20 | ≥ 0.2 | 0.944 | 0.944 | — | 1.000 | 0.944 | 0.944 | 0.17 | 0.250 | 0 | 0 | 0 | 0 | 0 | 1.71 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17 retrieve | 20 | ≥ 0.3 | 0.944 | 0.944 | — | 1.000 | 0.944 | 0.944 | 0.17 | 0.250 | 0 | 0 | 0 | 0 | 0 | 1.71 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17 retrieve | 20 | ≥ 0.5 | 0.944 | 0.944 | — | 1.000 | 0.944 | 0.944 | 0.17 | 0.250 | 0 | 0 | 0 | 0 | 0 | 1.71 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17 retrieve | 20 | ≥ 0.7 | 0.944 | 0.944 | — | 1.000 | 0.944 | 0.944 | 0.17 | 0.250 | 0 | 0 | 0 | 0 | 0 | 1.71 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17 retrieve | 50 | ≥ 0.01 | 0.944 | 0.944 | — | 1.000 | 0.944 | 0.944 | 0.22 | 0.500 | 0 | 0 | 0 | 0 | 0 | 1.49 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17 retrieve | 50 | ≥ 0.02 | 0.944 | 0.944 | — | 1.000 | 0.944 | 0.944 | 0.22 | 0.500 | 0 | 0 | 0 | 0 | 0 | 1.49 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17 retrieve | 50 | ≥ 0.05 | 0.944 | 0.944 | — | 1.000 | 0.944 | 0.944 | 0.17 | 0.250 | 0 | 0 | 0 | 0 | 0 | 1.49 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17 retrieve | 50 | ≥ 0.1 | 0.944 | 0.944 | — | 1.000 | 0.944 | 0.944 | 0.17 | 0.250 | 0 | 0 | 0 | 0 | 0 | 1.49 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17 retrieve | 50 | ≥ 0.2 | 0.944 | 0.944 | — | 1.000 | 0.944 | 0.944 | 0.17 | 0.250 | 0 | 0 | 0 | 0 | 0 | 1.49 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17 retrieve | 50 | ≥ 0.3 | 0.944 | 0.944 | — | 1.000 | 0.944 | 0.944 | 0.17 | 0.250 | 0 | 0 | 0 | 0 | 0 | 1.49 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17 retrieve | 50 | ≥ 0.5 | 0.944 | 0.944 | — | 1.000 | 0.944 | 0.944 | 0.17 | 0.250 | 0 | 0 | 0 | 0 | 0 | 1.49 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17 retrieve | 50 | ≥ 0.7 | 0.944 | 0.944 | — | 1.000 | 0.944 | 0.944 | 0.17 | 0.250 | 0 | 0 | 0 | 0 | 0 | 1.49 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17, any-word share | 10 | ≥ 0.01 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.44 | 0.500 | 0 | 0 | 0 | 0 | 0 | 91.2 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17, any-word share | 10 | ≥ 0.02 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.44 | 0.500 | 0 | 0 | 0 | 0 | 0 | 91.2 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17, any-word share | 10 | ≥ 0.05 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.28 | 0.250 | 0 | 0 | 0 | 0 | 0 | 91.2 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17, any-word share | 10 | ≥ 0.1 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.28 | 0.250 | 0 | 0 | 0 | 0 | 0 | 91.2 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17, any-word share | 10 | ≥ 0.2 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.28 | 0.250 | 0 | 0 | 0 | 0 | 0 | 91.2 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17, any-word share | 10 | ≥ 0.3 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.28 | 0.250 | 0 | 0 | 0 | 0 | 0 | 91.2 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17, any-word share | 10 | ≥ 0.5 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.28 | 0.250 | 0 | 0 | 0 | 0 | 0 | 91.2 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17, any-word share | 10 | ≥ 0.7 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.28 | 0.250 | 0 | 0 | 0 | 0 | 0 | 91.2 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17, any-word share | 20 | ≥ 0.01 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.44 | 0.500 | 0 | 0 | 0 | 0 | 0 | 126.8 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17, any-word share | 20 | ≥ 0.02 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.44 | 0.500 | 0 | 0 | 0 | 0 | 0 | 126.8 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17, any-word share | 20 | ≥ 0.05 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.28 | 0.250 | 0 | 0 | 0 | 0 | 0 | 126.8 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17, any-word share | 20 | ≥ 0.1 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.28 | 0.250 | 0 | 0 | 0 | 0 | 0 | 126.8 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17, any-word share | 20 | ≥ 0.2 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.28 | 0.250 | 0 | 0 | 0 | 0 | 0 | 126.8 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17, any-word share | 20 | ≥ 0.3 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.28 | 0.250 | 0 | 0 | 0 | 0 | 0 | 126.8 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17, any-word share | 20 | ≥ 0.5 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.28 | 0.250 | 0 | 0 | 0 | 0 | 0 | 126.8 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17, any-word share | 20 | ≥ 0.7 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.28 | 0.250 | 0 | 0 | 0 | 0 | 0 | 126.8 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17, any-word share | 50 | ≥ 0.01 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.44 | 0.500 | 0 | 0 | 0 | 0 | 0 | 160.0 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17, any-word share | 50 | ≥ 0.02 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.44 | 0.500 | 0 | 0 | 0 | 0 | 0 | 160.0 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17, any-word share | 50 | ≥ 0.05 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.28 | 0.250 | 0 | 0 | 0 | 0 | 0 | 160.0 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17, any-word share | 50 | ≥ 0.1 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.28 | 0.250 | 0 | 0 | 0 | 0 | 0 | 160.0 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17, any-word share | 50 | ≥ 0.2 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.28 | 0.250 | 0 | 0 | 0 | 0 | 0 | 160.0 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17, any-word share | 50 | ≥ 0.3 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.28 | 0.250 | 0 | 0 | 0 | 0 | 0 | 160.0 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17, any-word share | 50 | ≥ 0.5 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.28 | 0.250 | 0 | 0 | 0 | 0 | 0 | 160.0 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17, any-word share | 50 | ≥ 0.7 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.28 | 0.250 | 0 | 0 | 0 | 0 | 0 | 160.0 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | RRF of any-word and vector ≥ 0.30 | 10 | ≥ 0.01 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 1.06 | 0.500 | 0 | 0 | 0 | 1 | 0 | 141.2 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | RRF of any-word and vector ≥ 0.30 | 10 | ≥ 0.02 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.89 | 0.500 | 0 | 0 | 0 | 0 | 0 | 141.2 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | RRF of any-word and vector ≥ 0.30 | 10 | ≥ 0.05 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.67 | 0.250 | 0 | 0 | 0 | 0 | 0 | 141.2 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | RRF of any-word and vector ≥ 0.30 | 10 | ≥ 0.1 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.50 | 0.250 | 0 | 0 | 0 | 0 | 0 | 141.2 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | RRF of any-word and vector ≥ 0.30 | 10 | ≥ 0.2 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.50 | 0.250 | 0 | 0 | 0 | 0 | 0 | 141.2 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | RRF of any-word and vector ≥ 0.30 | 10 | ≥ 0.3 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.50 | 0.250 | 0 | 0 | 0 | 0 | 0 | 141.2 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | RRF of any-word and vector ≥ 0.30 | 10 | ≥ 0.5 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.44 | 0.250 | 0 | 0 | 0 | 0 | 0 | 141.2 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | RRF of any-word and vector ≥ 0.30 | 10 | ≥ 0.7 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.44 | 0.250 | 0 | 0 | 0 | 0 | 0 | 141.2 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | RRF of any-word and vector ≥ 0.30 | 20 | ≥ 0.01 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 1.06 | 0.500 | 0 | 0 | 0 | 1 | 0 | 252.7 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | RRF of any-word and vector ≥ 0.30 | 20 | ≥ 0.02 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.89 | 0.500 | 0 | 0 | 0 | 0 | 0 | 252.7 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | RRF of any-word and vector ≥ 0.30 | 20 | ≥ 0.05 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.67 | 0.250 | 0 | 0 | 0 | 0 | 0 | 252.7 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | RRF of any-word and vector ≥ 0.30 | 20 | ≥ 0.1 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.50 | 0.250 | 0 | 0 | 0 | 0 | 0 | 252.7 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | RRF of any-word and vector ≥ 0.30 | 20 | ≥ 0.2 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.50 | 0.250 | 0 | 0 | 0 | 0 | 0 | 252.7 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | RRF of any-word and vector ≥ 0.30 | 20 | ≥ 0.3 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.50 | 0.250 | 0 | 0 | 0 | 0 | 0 | 252.7 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | RRF of any-word and vector ≥ 0.30 | 20 | ≥ 0.5 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.44 | 0.250 | 0 | 0 | 0 | 0 | 0 | 252.7 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | RRF of any-word and vector ≥ 0.30 | 20 | ≥ 0.7 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.44 | 0.250 | 0 | 0 | 0 | 0 | 0 | 252.7 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | RRF of any-word and vector ≥ 0.30 | 50 | ≥ 0.01 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 1.06 | 0.500 | 0 | 0 | 0 | 1 | 0 | 274.9 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | RRF of any-word and vector ≥ 0.30 | 50 | ≥ 0.02 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.89 | 0.500 | 0 | 0 | 0 | 0 | 0 | 274.9 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | RRF of any-word and vector ≥ 0.30 | 50 | ≥ 0.05 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.67 | 0.250 | 0 | 0 | 0 | 0 | 0 | 274.9 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | RRF of any-word and vector ≥ 0.30 | 50 | ≥ 0.1 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.50 | 0.250 | 0 | 0 | 0 | 0 | 0 | 274.9 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | RRF of any-word and vector ≥ 0.30 | 50 | ≥ 0.2 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.50 | 0.250 | 0 | 0 | 0 | 0 | 0 | 274.9 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | RRF of any-word and vector ≥ 0.30 | 50 | ≥ 0.3 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.50 | 0.250 | 0 | 0 | 0 | 0 | 0 | 274.9 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | RRF of any-word and vector ≥ 0.30 | 50 | ≥ 0.5 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.44 | 0.250 | 0 | 0 | 0 | 0 | 0 | 274.9 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | RRF of any-word and vector ≥ 0.30 | 50 | ≥ 0.7 | 1.000 | 1.000 | — | 1.000 | 1.000 | 1.000 | 0.44 | 0.250 | 0 | 0 | 0 | 0 | 0 | 274.9 |

## Every configuration on heldout-2.json

| Reranker | Source | Depth | Relevance | Recall@5 | Recall@10 | Exact recall@5 | Paraphrase recall@10 | MRR | nDCG@10 | Non-relevant in top 10 | No-answer returning anything | Obsolete | Exposure | Errors | Duplicates | Fetches | Model p95 (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17 retrieve | 10 | ≥ 0.01 | 0.381 | 0.381 | — | 0.071 | 0.381 | 0.381 | 0.57 | 0.308 | 0 | 0 | 0 | 0 | 0 | 68.9 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17 retrieve | 10 | ≥ 0.02 | 0.333 | 0.333 | — | 0.000 | 0.333 | 0.333 | 0.52 | 0.308 | 0 | 0 | 0 | 0 | 0 | 68.9 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17 retrieve | 10 | ≥ 0.05 | 0.333 | 0.333 | — | 0.000 | 0.333 | 0.333 | 0.38 | 0.308 | 0 | 0 | 0 | 0 | 0 | 68.9 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17 retrieve | 10 | ≥ 0.1 | 0.333 | 0.333 | — | 0.000 | 0.333 | 0.333 | 0.24 | 0.308 | 0 | 0 | 0 | 0 | 0 | 68.9 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17 retrieve | 10 | ≥ 0.2 | 0.333 | 0.333 | — | 0.000 | 0.333 | 0.333 | 0.19 | 0.308 | 0 | 0 | 0 | 0 | 0 | 68.9 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17 retrieve | 10 | ≥ 0.3 | 0.333 | 0.333 | — | 0.000 | 0.333 | 0.333 | 0.19 | 0.308 | 0 | 0 | 0 | 0 | 0 | 68.9 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17 retrieve | 10 | ≥ 0.5 | 0.333 | 0.333 | — | 0.000 | 0.333 | 0.333 | 0.19 | 0.308 | 0 | 0 | 0 | 0 | 0 | 68.9 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17 retrieve | 10 | ≥ 0.7 | 0.333 | 0.333 | — | 0.000 | 0.333 | 0.333 | 0.10 | 0.231 | 0 | 0 | 0 | 0 | 0 | 68.9 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17 retrieve | 20 | ≥ 0.01 | 0.381 | 0.381 | — | 0.071 | 0.381 | 0.381 | 0.57 | 0.308 | 0 | 0 | 0 | 0 | 0 | 32.9 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17 retrieve | 20 | ≥ 0.02 | 0.333 | 0.333 | — | 0.000 | 0.333 | 0.333 | 0.52 | 0.308 | 0 | 0 | 0 | 0 | 0 | 32.9 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17 retrieve | 20 | ≥ 0.05 | 0.333 | 0.333 | — | 0.000 | 0.333 | 0.333 | 0.38 | 0.308 | 0 | 0 | 0 | 0 | 0 | 32.9 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17 retrieve | 20 | ≥ 0.1 | 0.333 | 0.333 | — | 0.000 | 0.333 | 0.333 | 0.24 | 0.308 | 0 | 0 | 0 | 0 | 0 | 32.9 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17 retrieve | 20 | ≥ 0.2 | 0.333 | 0.333 | — | 0.000 | 0.333 | 0.333 | 0.19 | 0.308 | 0 | 0 | 0 | 0 | 0 | 32.9 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17 retrieve | 20 | ≥ 0.3 | 0.333 | 0.333 | — | 0.000 | 0.333 | 0.333 | 0.19 | 0.308 | 0 | 0 | 0 | 0 | 0 | 32.9 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17 retrieve | 20 | ≥ 0.5 | 0.333 | 0.333 | — | 0.000 | 0.333 | 0.333 | 0.19 | 0.308 | 0 | 0 | 0 | 0 | 0 | 32.9 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17 retrieve | 20 | ≥ 0.7 | 0.333 | 0.333 | — | 0.000 | 0.333 | 0.333 | 0.10 | 0.231 | 0 | 0 | 0 | 0 | 0 | 32.9 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17 retrieve | 50 | ≥ 0.01 | 0.381 | 0.381 | — | 0.071 | 0.381 | 0.381 | 0.57 | 0.308 | 0 | 0 | 0 | 0 | 0 | 18.0 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17 retrieve | 50 | ≥ 0.02 | 0.333 | 0.333 | — | 0.000 | 0.333 | 0.333 | 0.52 | 0.308 | 0 | 0 | 0 | 0 | 0 | 18.0 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17 retrieve | 50 | ≥ 0.05 | 0.333 | 0.333 | — | 0.000 | 0.333 | 0.333 | 0.38 | 0.308 | 0 | 0 | 0 | 0 | 0 | 18.0 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17 retrieve | 50 | ≥ 0.1 | 0.333 | 0.333 | — | 0.000 | 0.333 | 0.333 | 0.24 | 0.308 | 0 | 0 | 0 | 0 | 0 | 18.0 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17 retrieve | 50 | ≥ 0.2 | 0.333 | 0.333 | — | 0.000 | 0.333 | 0.333 | 0.19 | 0.308 | 0 | 0 | 0 | 0 | 0 | 18.0 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17 retrieve | 50 | ≥ 0.3 | 0.333 | 0.333 | — | 0.000 | 0.333 | 0.333 | 0.19 | 0.308 | 0 | 0 | 0 | 0 | 0 | 18.0 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17 retrieve | 50 | ≥ 0.5 | 0.333 | 0.333 | — | 0.000 | 0.333 | 0.333 | 0.19 | 0.308 | 0 | 0 | 0 | 0 | 0 | 18.0 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17 retrieve | 50 | ≥ 0.7 | 0.333 | 0.333 | — | 0.000 | 0.333 | 0.333 | 0.10 | 0.231 | 0 | 0 | 0 | 0 | 0 | 18.0 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17, any-word share | 10 | ≥ 0.01 | 0.619 | 0.619 | — | 0.429 | 0.587 | 0.595 | 1.00 | 0.615 | 0 | 0 | 0 | 0 | 0 | 1018.8 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17, any-word share | 10 | ≥ 0.02 | 0.571 | 0.571 | — | 0.357 | 0.540 | 0.548 | 0.76 | 0.462 | 0 | 0 | 0 | 0 | 0 | 1018.8 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17, any-word share | 10 | ≥ 0.05 | 0.524 | 0.524 | — | 0.286 | 0.524 | 0.524 | 0.52 | 0.462 | 0 | 0 | 0 | 0 | 0 | 1018.8 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17, any-word share | 10 | ≥ 0.1 | 0.524 | 0.524 | — | 0.286 | 0.524 | 0.524 | 0.33 | 0.385 | 0 | 0 | 0 | 0 | 0 | 1018.8 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17, any-word share | 10 | ≥ 0.2 | 0.429 | 0.429 | — | 0.143 | 0.429 | 0.429 | 0.19 | 0.385 | 0 | 0 | 0 | 0 | 0 | 1018.8 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17, any-word share | 10 | ≥ 0.3 | 0.429 | 0.429 | — | 0.143 | 0.429 | 0.429 | 0.19 | 0.308 | 0 | 0 | 0 | 0 | 0 | 1018.8 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17, any-word share | 10 | ≥ 0.5 | 0.381 | 0.381 | — | 0.071 | 0.381 | 0.381 | 0.19 | 0.308 | 0 | 0 | 0 | 0 | 0 | 1018.8 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17, any-word share | 10 | ≥ 0.7 | 0.381 | 0.381 | — | 0.071 | 0.381 | 0.381 | 0.10 | 0.231 | 0 | 0 | 0 | 0 | 0 | 1018.8 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17, any-word share | 20 | ≥ 0.01 | 0.619 | 0.619 | — | 0.429 | 0.587 | 0.595 | 1.00 | 0.615 | 0 | 0 | 0 | 0 | 0 | 2161.7 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17, any-word share | 20 | ≥ 0.02 | 0.571 | 0.571 | — | 0.357 | 0.540 | 0.548 | 0.76 | 0.462 | 0 | 0 | 0 | 0 | 0 | 2161.7 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17, any-word share | 20 | ≥ 0.05 | 0.524 | 0.524 | — | 0.286 | 0.524 | 0.524 | 0.52 | 0.462 | 0 | 0 | 0 | 0 | 0 | 2161.7 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17, any-word share | 20 | ≥ 0.1 | 0.524 | 0.524 | — | 0.286 | 0.524 | 0.524 | 0.33 | 0.385 | 0 | 0 | 0 | 0 | 0 | 2161.7 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17, any-word share | 20 | ≥ 0.2 | 0.429 | 0.429 | — | 0.143 | 0.429 | 0.429 | 0.19 | 0.385 | 0 | 0 | 0 | 0 | 0 | 2161.7 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17, any-word share | 20 | ≥ 0.3 | 0.429 | 0.429 | — | 0.143 | 0.429 | 0.429 | 0.19 | 0.308 | 0 | 0 | 0 | 0 | 0 | 2161.7 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17, any-word share | 20 | ≥ 0.5 | 0.381 | 0.381 | — | 0.071 | 0.381 | 0.381 | 0.19 | 0.308 | 0 | 0 | 0 | 0 | 0 | 2161.7 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17, any-word share | 20 | ≥ 0.7 | 0.381 | 0.381 | — | 0.071 | 0.381 | 0.381 | 0.10 | 0.231 | 0 | 0 | 0 | 0 | 0 | 2161.7 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17, any-word share | 50 | ≥ 0.01 | 0.619 | 0.619 | — | 0.429 | 0.587 | 0.595 | 1.00 | 0.615 | 0 | 0 | 0 | 0 | 0 | 2560.9 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17, any-word share | 50 | ≥ 0.02 | 0.571 | 0.571 | — | 0.357 | 0.540 | 0.548 | 0.76 | 0.462 | 0 | 0 | 0 | 0 | 0 | 2560.9 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17, any-word share | 50 | ≥ 0.05 | 0.524 | 0.524 | — | 0.286 | 0.524 | 0.524 | 0.52 | 0.462 | 0 | 0 | 0 | 0 | 0 | 2560.9 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17, any-word share | 50 | ≥ 0.1 | 0.524 | 0.524 | — | 0.286 | 0.524 | 0.524 | 0.33 | 0.385 | 0 | 0 | 0 | 0 | 0 | 2560.9 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17, any-word share | 50 | ≥ 0.2 | 0.429 | 0.429 | — | 0.143 | 0.429 | 0.429 | 0.19 | 0.385 | 0 | 0 | 0 | 0 | 0 | 2560.9 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17, any-word share | 50 | ≥ 0.3 | 0.429 | 0.429 | — | 0.143 | 0.429 | 0.429 | 0.19 | 0.308 | 0 | 0 | 0 | 0 | 0 | 2560.9 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17, any-word share | 50 | ≥ 0.5 | 0.381 | 0.381 | — | 0.071 | 0.381 | 0.381 | 0.19 | 0.308 | 0 | 0 | 0 | 0 | 0 | 2560.9 |
| Xenova/ms-marco-MiniLM-L-6-v2 | S17, any-word share | 50 | ≥ 0.7 | 0.381 | 0.381 | — | 0.071 | 0.381 | 0.381 | 0.10 | 0.231 | 0 | 0 | 0 | 0 | 0 | 2560.9 |
| Xenova/ms-marco-MiniLM-L-6-v2 | RRF of any-word and vector ≥ 0.30 | 10 | ≥ 0.01 | 0.762 | 0.762 | — | 0.643 | 0.730 | 0.738 | 1.71 | 0.692 | 0 | 0 | 0 | 1 | 0 | 964.8 |
| Xenova/ms-marco-MiniLM-L-6-v2 | RRF of any-word and vector ≥ 0.30 | 10 | ≥ 0.02 | 0.714 | 0.714 | — | 0.571 | 0.683 | 0.690 | 1.24 | 0.538 | 0 | 0 | 0 | 1 | 0 | 964.8 |
| Xenova/ms-marco-MiniLM-L-6-v2 | RRF of any-word and vector ≥ 0.30 | 10 | ≥ 0.05 | 0.667 | 0.667 | — | 0.500 | 0.667 | 0.667 | 0.90 | 0.462 | 0 | 0 | 0 | 1 | 0 | 964.8 |
| Xenova/ms-marco-MiniLM-L-6-v2 | RRF of any-word and vector ≥ 0.30 | 10 | ≥ 0.1 | 0.667 | 0.667 | — | 0.500 | 0.667 | 0.667 | 0.57 | 0.385 | 0 | 0 | 0 | 1 | 0 | 964.8 |
| Xenova/ms-marco-MiniLM-L-6-v2 | RRF of any-word and vector ≥ 0.30 | 10 | ≥ 0.2 | 0.571 | 0.571 | — | 0.357 | 0.571 | 0.571 | 0.29 | 0.385 | 0 | 0 | 0 | 1 | 0 | 964.8 |
| Xenova/ms-marco-MiniLM-L-6-v2 | RRF of any-word and vector ≥ 0.30 | 10 | ≥ 0.3 | 0.571 | 0.571 | — | 0.357 | 0.571 | 0.571 | 0.24 | 0.308 | 0 | 0 | 0 | 1 | 0 | 964.8 |
| Xenova/ms-marco-MiniLM-L-6-v2 | RRF of any-word and vector ≥ 0.30 | 10 | ≥ 0.5 | 0.524 | 0.524 | — | 0.286 | 0.524 | 0.524 | 0.19 | 0.308 | 0 | 0 | 0 | 1 | 0 | 964.8 |
| Xenova/ms-marco-MiniLM-L-6-v2 | RRF of any-word and vector ≥ 0.30 | 10 | ≥ 0.7 | 0.524 | 0.524 | — | 0.286 | 0.524 | 0.524 | 0.10 | 0.231 | 0 | 0 | 0 | 1 | 0 | 964.8 |
| Xenova/ms-marco-MiniLM-L-6-v2 | RRF of any-word and vector ≥ 0.30 | 20 | ≥ 0.01 | 0.762 | 0.762 | — | 0.643 | 0.730 | 0.738 | 1.86 | 0.769 | 0 | 0 | 0 | 1 | 0 | 2475.8 |
| Xenova/ms-marco-MiniLM-L-6-v2 | RRF of any-word and vector ≥ 0.30 | 20 | ≥ 0.02 | 0.714 | 0.714 | — | 0.571 | 0.683 | 0.690 | 1.38 | 0.615 | 0 | 0 | 0 | 1 | 0 | 2475.8 |
| Xenova/ms-marco-MiniLM-L-6-v2 | RRF of any-word and vector ≥ 0.30 | 20 | ≥ 0.05 | 0.667 | 0.667 | — | 0.500 | 0.667 | 0.667 | 0.95 | 0.538 | 0 | 0 | 0 | 1 | 0 | 2475.8 |
| Xenova/ms-marco-MiniLM-L-6-v2 | RRF of any-word and vector ≥ 0.30 | 20 | ≥ 0.1 | 0.667 | 0.667 | — | 0.500 | 0.667 | 0.667 | 0.57 | 0.385 | 0 | 0 | 0 | 1 | 0 | 2475.8 |
| Xenova/ms-marco-MiniLM-L-6-v2 | RRF of any-word and vector ≥ 0.30 | 20 | ≥ 0.2 | 0.571 | 0.571 | — | 0.357 | 0.571 | 0.571 | 0.29 | 0.385 | 0 | 0 | 0 | 1 | 0 | 2475.8 |
| Xenova/ms-marco-MiniLM-L-6-v2 | RRF of any-word and vector ≥ 0.30 | 20 | ≥ 0.3 | 0.571 | 0.571 | — | 0.357 | 0.571 | 0.571 | 0.24 | 0.308 | 0 | 0 | 0 | 1 | 0 | 2475.8 |
| Xenova/ms-marco-MiniLM-L-6-v2 | RRF of any-word and vector ≥ 0.30 | 20 | ≥ 0.5 | 0.524 | 0.524 | — | 0.286 | 0.524 | 0.524 | 0.19 | 0.308 | 0 | 0 | 0 | 1 | 0 | 2475.8 |
| Xenova/ms-marco-MiniLM-L-6-v2 | RRF of any-word and vector ≥ 0.30 | 20 | ≥ 0.7 | 0.524 | 0.524 | — | 0.286 | 0.524 | 0.524 | 0.10 | 0.231 | 0 | 0 | 0 | 1 | 0 | 2475.8 |
| Xenova/ms-marco-MiniLM-L-6-v2 | RRF of any-word and vector ≥ 0.30 | 50 | ≥ 0.01 | 0.762 | 0.762 | — | 0.643 | 0.730 | 0.738 | 1.86 | 0.769 | 0 | 0 | 0 | 1 | 0 | 2292.1 |
| Xenova/ms-marco-MiniLM-L-6-v2 | RRF of any-word and vector ≥ 0.30 | 50 | ≥ 0.02 | 0.714 | 0.714 | — | 0.571 | 0.683 | 0.690 | 1.38 | 0.615 | 0 | 0 | 0 | 1 | 0 | 2292.1 |
| Xenova/ms-marco-MiniLM-L-6-v2 | RRF of any-word and vector ≥ 0.30 | 50 | ≥ 0.05 | 0.667 | 0.667 | — | 0.500 | 0.667 | 0.667 | 0.95 | 0.538 | 0 | 0 | 0 | 1 | 0 | 2292.1 |
| Xenova/ms-marco-MiniLM-L-6-v2 | RRF of any-word and vector ≥ 0.30 | 50 | ≥ 0.1 | 0.667 | 0.667 | — | 0.500 | 0.667 | 0.667 | 0.57 | 0.385 | 0 | 0 | 0 | 1 | 0 | 2292.1 |
| Xenova/ms-marco-MiniLM-L-6-v2 | RRF of any-word and vector ≥ 0.30 | 50 | ≥ 0.2 | 0.571 | 0.571 | — | 0.357 | 0.571 | 0.571 | 0.29 | 0.385 | 0 | 0 | 0 | 1 | 0 | 2292.1 |
| Xenova/ms-marco-MiniLM-L-6-v2 | RRF of any-word and vector ≥ 0.30 | 50 | ≥ 0.3 | 0.571 | 0.571 | — | 0.357 | 0.571 | 0.571 | 0.24 | 0.308 | 0 | 0 | 0 | 1 | 0 | 2292.1 |
| Xenova/ms-marco-MiniLM-L-6-v2 | RRF of any-word and vector ≥ 0.30 | 50 | ≥ 0.5 | 0.524 | 0.524 | — | 0.286 | 0.524 | 0.524 | 0.19 | 0.308 | 0 | 0 | 0 | 1 | 0 | 2292.1 |
| Xenova/ms-marco-MiniLM-L-6-v2 | RRF of any-word and vector ≥ 0.30 | 50 | ≥ 0.7 | 0.524 | 0.524 | — | 0.286 | 0.524 | 0.524 | 0.10 | 0.231 | 0 | 0 | 0 | 1 | 0 | 2292.1 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17 retrieve | 10 | ≥ 0.01 | 0.381 | 0.381 | — | 0.071 | 0.357 | 0.363 | 0.43 | 0.231 | 0 | 0 | 0 | 0 | 0 | 3.28 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17 retrieve | 10 | ≥ 0.02 | 0.381 | 0.381 | — | 0.071 | 0.357 | 0.363 | 0.38 | 0.231 | 0 | 0 | 0 | 0 | 0 | 3.28 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17 retrieve | 10 | ≥ 0.05 | 0.381 | 0.381 | — | 0.071 | 0.357 | 0.363 | 0.38 | 0.231 | 0 | 0 | 0 | 0 | 0 | 3.28 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17 retrieve | 10 | ≥ 0.1 | 0.381 | 0.381 | — | 0.071 | 0.357 | 0.363 | 0.33 | 0.231 | 0 | 0 | 0 | 0 | 0 | 3.28 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17 retrieve | 10 | ≥ 0.2 | 0.333 | 0.333 | — | 0.000 | 0.333 | 0.333 | 0.14 | 0.231 | 0 | 0 | 0 | 0 | 0 | 3.28 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17 retrieve | 10 | ≥ 0.3 | 0.333 | 0.333 | — | 0.000 | 0.333 | 0.333 | 0.14 | 0.231 | 0 | 0 | 0 | 0 | 0 | 3.28 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17 retrieve | 10 | ≥ 0.5 | 0.333 | 0.333 | — | 0.000 | 0.333 | 0.333 | 0.14 | 0.231 | 0 | 0 | 0 | 0 | 0 | 3.28 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17 retrieve | 10 | ≥ 0.7 | 0.286 | 0.286 | — | 0.000 | 0.286 | 0.286 | 0.14 | 0.231 | 0 | 0 | 0 | 0 | 0 | 3.28 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17 retrieve | 20 | ≥ 0.01 | 0.381 | 0.381 | — | 0.071 | 0.357 | 0.363 | 0.43 | 0.231 | 0 | 0 | 0 | 0 | 0 | 1.71 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17 retrieve | 20 | ≥ 0.02 | 0.381 | 0.381 | — | 0.071 | 0.357 | 0.363 | 0.38 | 0.231 | 0 | 0 | 0 | 0 | 0 | 1.71 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17 retrieve | 20 | ≥ 0.05 | 0.381 | 0.381 | — | 0.071 | 0.357 | 0.363 | 0.38 | 0.231 | 0 | 0 | 0 | 0 | 0 | 1.71 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17 retrieve | 20 | ≥ 0.1 | 0.381 | 0.381 | — | 0.071 | 0.357 | 0.363 | 0.33 | 0.231 | 0 | 0 | 0 | 0 | 0 | 1.71 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17 retrieve | 20 | ≥ 0.2 | 0.333 | 0.333 | — | 0.000 | 0.333 | 0.333 | 0.14 | 0.231 | 0 | 0 | 0 | 0 | 0 | 1.71 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17 retrieve | 20 | ≥ 0.3 | 0.333 | 0.333 | — | 0.000 | 0.333 | 0.333 | 0.14 | 0.231 | 0 | 0 | 0 | 0 | 0 | 1.71 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17 retrieve | 20 | ≥ 0.5 | 0.333 | 0.333 | — | 0.000 | 0.333 | 0.333 | 0.14 | 0.231 | 0 | 0 | 0 | 0 | 0 | 1.71 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17 retrieve | 20 | ≥ 0.7 | 0.286 | 0.286 | — | 0.000 | 0.286 | 0.286 | 0.14 | 0.231 | 0 | 0 | 0 | 0 | 0 | 1.71 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17 retrieve | 50 | ≥ 0.01 | 0.381 | 0.381 | — | 0.071 | 0.357 | 0.363 | 0.43 | 0.231 | 0 | 0 | 0 | 0 | 0 | 1.49 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17 retrieve | 50 | ≥ 0.02 | 0.381 | 0.381 | — | 0.071 | 0.357 | 0.363 | 0.38 | 0.231 | 0 | 0 | 0 | 0 | 0 | 1.49 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17 retrieve | 50 | ≥ 0.05 | 0.381 | 0.381 | — | 0.071 | 0.357 | 0.363 | 0.38 | 0.231 | 0 | 0 | 0 | 0 | 0 | 1.49 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17 retrieve | 50 | ≥ 0.1 | 0.381 | 0.381 | — | 0.071 | 0.357 | 0.363 | 0.33 | 0.231 | 0 | 0 | 0 | 0 | 0 | 1.49 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17 retrieve | 50 | ≥ 0.2 | 0.333 | 0.333 | — | 0.000 | 0.333 | 0.333 | 0.14 | 0.231 | 0 | 0 | 0 | 0 | 0 | 1.49 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17 retrieve | 50 | ≥ 0.3 | 0.333 | 0.333 | — | 0.000 | 0.333 | 0.333 | 0.14 | 0.231 | 0 | 0 | 0 | 0 | 0 | 1.49 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17 retrieve | 50 | ≥ 0.5 | 0.333 | 0.333 | — | 0.000 | 0.333 | 0.333 | 0.14 | 0.231 | 0 | 0 | 0 | 0 | 0 | 1.49 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17 retrieve | 50 | ≥ 0.7 | 0.286 | 0.286 | — | 0.000 | 0.286 | 0.286 | 0.14 | 0.231 | 0 | 0 | 0 | 0 | 0 | 1.49 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17, any-word share | 10 | ≥ 0.01 | 0.429 | 0.429 | — | 0.143 | 0.405 | 0.411 | 0.43 | 0.308 | 0 | 0 | 0 | 0 | 0 | 91.2 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17, any-word share | 10 | ≥ 0.02 | 0.429 | 0.429 | — | 0.143 | 0.405 | 0.411 | 0.38 | 0.308 | 0 | 0 | 0 | 0 | 0 | 91.2 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17, any-word share | 10 | ≥ 0.05 | 0.429 | 0.429 | — | 0.143 | 0.405 | 0.411 | 0.38 | 0.231 | 0 | 0 | 0 | 0 | 0 | 91.2 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17, any-word share | 10 | ≥ 0.1 | 0.381 | 0.381 | — | 0.071 | 0.357 | 0.363 | 0.33 | 0.231 | 0 | 0 | 0 | 0 | 0 | 91.2 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17, any-word share | 10 | ≥ 0.2 | 0.333 | 0.333 | — | 0.000 | 0.333 | 0.333 | 0.14 | 0.231 | 0 | 0 | 0 | 0 | 0 | 91.2 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17, any-word share | 10 | ≥ 0.3 | 0.333 | 0.333 | — | 0.000 | 0.333 | 0.333 | 0.14 | 0.231 | 0 | 0 | 0 | 0 | 0 | 91.2 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17, any-word share | 10 | ≥ 0.5 | 0.333 | 0.333 | — | 0.000 | 0.333 | 0.333 | 0.14 | 0.231 | 0 | 0 | 0 | 0 | 0 | 91.2 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17, any-word share | 10 | ≥ 0.7 | 0.286 | 0.286 | — | 0.000 | 0.286 | 0.286 | 0.14 | 0.231 | 0 | 0 | 0 | 0 | 0 | 91.2 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17, any-word share | 20 | ≥ 0.01 | 0.429 | 0.429 | — | 0.143 | 0.405 | 0.411 | 0.43 | 0.308 | 0 | 0 | 0 | 0 | 0 | 126.8 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17, any-word share | 20 | ≥ 0.02 | 0.429 | 0.429 | — | 0.143 | 0.405 | 0.411 | 0.38 | 0.308 | 0 | 0 | 0 | 0 | 0 | 126.8 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17, any-word share | 20 | ≥ 0.05 | 0.429 | 0.429 | — | 0.143 | 0.405 | 0.411 | 0.38 | 0.231 | 0 | 0 | 0 | 0 | 0 | 126.8 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17, any-word share | 20 | ≥ 0.1 | 0.381 | 0.381 | — | 0.071 | 0.357 | 0.363 | 0.33 | 0.231 | 0 | 0 | 0 | 0 | 0 | 126.8 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17, any-word share | 20 | ≥ 0.2 | 0.333 | 0.333 | — | 0.000 | 0.333 | 0.333 | 0.14 | 0.231 | 0 | 0 | 0 | 0 | 0 | 126.8 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17, any-word share | 20 | ≥ 0.3 | 0.333 | 0.333 | — | 0.000 | 0.333 | 0.333 | 0.14 | 0.231 | 0 | 0 | 0 | 0 | 0 | 126.8 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17, any-word share | 20 | ≥ 0.5 | 0.333 | 0.333 | — | 0.000 | 0.333 | 0.333 | 0.14 | 0.231 | 0 | 0 | 0 | 0 | 0 | 126.8 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17, any-word share | 20 | ≥ 0.7 | 0.286 | 0.286 | — | 0.000 | 0.286 | 0.286 | 0.14 | 0.231 | 0 | 0 | 0 | 0 | 0 | 126.8 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17, any-word share | 50 | ≥ 0.01 | 0.429 | 0.429 | — | 0.143 | 0.405 | 0.411 | 0.43 | 0.308 | 0 | 0 | 0 | 0 | 0 | 160.0 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17, any-word share | 50 | ≥ 0.02 | 0.429 | 0.429 | — | 0.143 | 0.405 | 0.411 | 0.38 | 0.308 | 0 | 0 | 0 | 0 | 0 | 160.0 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17, any-word share | 50 | ≥ 0.05 | 0.429 | 0.429 | — | 0.143 | 0.405 | 0.411 | 0.38 | 0.231 | 0 | 0 | 0 | 0 | 0 | 160.0 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17, any-word share | 50 | ≥ 0.1 | 0.381 | 0.381 | — | 0.071 | 0.357 | 0.363 | 0.33 | 0.231 | 0 | 0 | 0 | 0 | 0 | 160.0 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17, any-word share | 50 | ≥ 0.2 | 0.333 | 0.333 | — | 0.000 | 0.333 | 0.333 | 0.14 | 0.231 | 0 | 0 | 0 | 0 | 0 | 160.0 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17, any-word share | 50 | ≥ 0.3 | 0.333 | 0.333 | — | 0.000 | 0.333 | 0.333 | 0.14 | 0.231 | 0 | 0 | 0 | 0 | 0 | 160.0 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17, any-word share | 50 | ≥ 0.5 | 0.333 | 0.333 | — | 0.000 | 0.333 | 0.333 | 0.14 | 0.231 | 0 | 0 | 0 | 0 | 0 | 160.0 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | S17, any-word share | 50 | ≥ 0.7 | 0.286 | 0.286 | — | 0.000 | 0.286 | 0.286 | 0.14 | 0.231 | 0 | 0 | 0 | 0 | 0 | 160.0 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | RRF of any-word and vector ≥ 0.30 | 10 | ≥ 0.01 | 0.429 | 0.429 | — | 0.143 | 0.405 | 0.411 | 0.48 | 0.308 | 0 | 0 | 0 | 0 | 0 | 141.2 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | RRF of any-word and vector ≥ 0.30 | 10 | ≥ 0.02 | 0.429 | 0.429 | — | 0.143 | 0.405 | 0.411 | 0.43 | 0.308 | 0 | 0 | 0 | 0 | 0 | 141.2 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | RRF of any-word and vector ≥ 0.30 | 10 | ≥ 0.05 | 0.429 | 0.429 | — | 0.143 | 0.405 | 0.411 | 0.43 | 0.231 | 0 | 0 | 0 | 0 | 0 | 141.2 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | RRF of any-word and vector ≥ 0.30 | 10 | ≥ 0.1 | 0.381 | 0.381 | — | 0.071 | 0.357 | 0.363 | 0.38 | 0.231 | 0 | 0 | 0 | 0 | 0 | 141.2 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | RRF of any-word and vector ≥ 0.30 | 10 | ≥ 0.2 | 0.333 | 0.333 | — | 0.000 | 0.333 | 0.333 | 0.19 | 0.231 | 0 | 0 | 0 | 0 | 0 | 141.2 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | RRF of any-word and vector ≥ 0.30 | 10 | ≥ 0.3 | 0.333 | 0.333 | — | 0.000 | 0.333 | 0.333 | 0.19 | 0.231 | 0 | 0 | 0 | 0 | 0 | 141.2 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | RRF of any-word and vector ≥ 0.30 | 10 | ≥ 0.5 | 0.333 | 0.333 | — | 0.000 | 0.333 | 0.333 | 0.19 | 0.231 | 0 | 0 | 0 | 0 | 0 | 141.2 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | RRF of any-word and vector ≥ 0.30 | 10 | ≥ 0.7 | 0.286 | 0.286 | — | 0.000 | 0.286 | 0.286 | 0.19 | 0.231 | 0 | 0 | 0 | 0 | 0 | 141.2 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | RRF of any-word and vector ≥ 0.30 | 20 | ≥ 0.01 | 0.429 | 0.429 | — | 0.143 | 0.405 | 0.411 | 0.52 | 0.462 | 0 | 0 | 0 | 0 | 0 | 252.7 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | RRF of any-word and vector ≥ 0.30 | 20 | ≥ 0.02 | 0.429 | 0.429 | — | 0.143 | 0.405 | 0.411 | 0.48 | 0.462 | 0 | 0 | 0 | 0 | 0 | 252.7 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | RRF of any-word and vector ≥ 0.30 | 20 | ≥ 0.05 | 0.429 | 0.429 | — | 0.143 | 0.405 | 0.411 | 0.48 | 0.308 | 0 | 0 | 0 | 0 | 0 | 252.7 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | RRF of any-word and vector ≥ 0.30 | 20 | ≥ 0.1 | 0.381 | 0.381 | — | 0.071 | 0.357 | 0.363 | 0.43 | 0.308 | 0 | 0 | 0 | 0 | 0 | 252.7 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | RRF of any-word and vector ≥ 0.30 | 20 | ≥ 0.2 | 0.333 | 0.333 | — | 0.000 | 0.333 | 0.333 | 0.19 | 0.231 | 0 | 0 | 0 | 0 | 0 | 252.7 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | RRF of any-word and vector ≥ 0.30 | 20 | ≥ 0.3 | 0.333 | 0.333 | — | 0.000 | 0.333 | 0.333 | 0.19 | 0.231 | 0 | 0 | 0 | 0 | 0 | 252.7 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | RRF of any-word and vector ≥ 0.30 | 20 | ≥ 0.5 | 0.333 | 0.333 | — | 0.000 | 0.333 | 0.333 | 0.19 | 0.231 | 0 | 0 | 0 | 0 | 0 | 252.7 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | RRF of any-word and vector ≥ 0.30 | 20 | ≥ 0.7 | 0.286 | 0.286 | — | 0.000 | 0.286 | 0.286 | 0.19 | 0.231 | 0 | 0 | 0 | 0 | 0 | 252.7 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | RRF of any-word and vector ≥ 0.30 | 50 | ≥ 0.01 | 0.429 | 0.429 | — | 0.143 | 0.405 | 0.411 | 0.52 | 0.462 | 0 | 0 | 0 | 0 | 0 | 274.9 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | RRF of any-word and vector ≥ 0.30 | 50 | ≥ 0.02 | 0.429 | 0.429 | — | 0.143 | 0.405 | 0.411 | 0.48 | 0.462 | 0 | 0 | 0 | 0 | 0 | 274.9 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | RRF of any-word and vector ≥ 0.30 | 50 | ≥ 0.05 | 0.429 | 0.429 | — | 0.143 | 0.405 | 0.411 | 0.48 | 0.308 | 0 | 0 | 0 | 0 | 0 | 274.9 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | RRF of any-word and vector ≥ 0.30 | 50 | ≥ 0.1 | 0.381 | 0.381 | — | 0.071 | 0.357 | 0.363 | 0.43 | 0.308 | 0 | 0 | 0 | 0 | 0 | 274.9 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | RRF of any-word and vector ≥ 0.30 | 50 | ≥ 0.2 | 0.333 | 0.333 | — | 0.000 | 0.333 | 0.333 | 0.19 | 0.231 | 0 | 0 | 0 | 0 | 0 | 274.9 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | RRF of any-word and vector ≥ 0.30 | 50 | ≥ 0.3 | 0.333 | 0.333 | — | 0.000 | 0.333 | 0.333 | 0.19 | 0.231 | 0 | 0 | 0 | 0 | 0 | 274.9 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | RRF of any-word and vector ≥ 0.30 | 50 | ≥ 0.5 | 0.333 | 0.333 | — | 0.000 | 0.333 | 0.333 | 0.19 | 0.231 | 0 | 0 | 0 | 0 | 0 | 274.9 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | RRF of any-word and vector ≥ 0.30 | 50 | ≥ 0.7 | 0.286 | 0.286 | — | 0.000 | 0.286 | 0.286 | 0.19 | 0.231 | 0 | 0 | 0 | 0 | 0 | 274.9 |

## Corpus queries under the best configuration

| Query | Category | Outcome | First relevant rank | Recall@10 | Returned (top 5) |
| --- | --- | --- | --- | --- | --- |
| exact-error-code | exact | ok | 1 | 1.000 | error-e4012 |
| exact-ticket | exact | ok | 1 | 1.000 | ticket-alp-1182 |
| exact-person | exact | ok | 1 | 1.000 | owner-billing |
| exact-cluster | exact | ok | 1 | 1.000 | staging-current |
| para-token-lifetime | paraphrase | ok | 2 | 1.000 | audit-90, api-token-ttl, audit-365, backup-schedule, timeout-a |
| para-price-cache | paraphrase | ok | 1 | 1.000 | price-cache |
| para-billing-owner | paraphrase | ok | — | 0.000 | — |
| para-snapshots | paraphrase | ok | 1 | 1.000 | backup-schedule |
| para-rotation-day | paraphrase | ok | 1 | 1.000 | on-call, release-day, backup-schedule |
| para-toggles | paraphrase | ok | 1 | 1.000 | feature-flags |
| para-log-shape | paraphrase | ok | 1 | 1.000 | log-format, audit-365, audit-90, feature-flags |
| correct-release-new | correction | ok | 1 | 1.000 | release-day, noise-release-notes |
| correct-release-stale | correction | ok | 1 | 1.000 | release-day, noise-release-notes |
| correct-session-store | correction | ok | 1 | 1.000 | db-engine-v2, noise-session-ui, beta-session-plan |
| correct-postgres | correction | ok | 1 | 1.000 | db-engine-v2 |
| correct-rabbitmq | correction | ok | — | 0.000 | — |
| history-session-store | historical | ok | 1 | 1.000 | db-engine-v1, db-engine-v2, noise-session-ui, beta-session-plan |
| history-queue | historical | ok | 1 | 1.000 | queue-v1, queue-v2 |
| state-failover-default | lifecycle | ok | 1 | 1.000 | failover-current |
| state-failover-archived | lifecycle | ok | 1 | 1.000 | failover-old |
| state-staging-default | lifecycle | ok | 1 | 1.000 | staging-current |
| state-staging-tombstoned | lifecycle | ok | 1 | 1.000 | staging-old |
| noise-tokens | distractor | ok | 1 | 1.000 | api-token-ttl, noise-token-ui, beta-token-ttl |
| noise-release | distractor | ok | 1 | 1.000 | release-day, noise-release-notes |
| noise-backup | distractor | ok | 1 | 1.000 | backup-schedule, noise-backup-ui |
| noise-stale-cache | distractor | ok | 1 | 1.000 | price-cache, noise-browser-cache |
| noise-session | distractor | ok | 1 | 1.000 | db-engine-v2, noise-session-ui |
| scope-tokens | cross-namespace | ok | 1 | 1.000 | api-token-ttl |
| scope-session | cross-namespace | ok | 1 | 1.000 | db-engine-v2 |
| scope-queue-history | cross-namespace | ok | 1 | 1.000 | queue-v1 |
| scope-named-foreign | cross-namespace | expected-error (Forbidden) | — | — | — |
| large-architecture | large-content | ok | 1 | 1.000 | arch-summary, arch-overview |
| none-autoscaling | no-answer | ok | — | — | — |
| none-budget | no-answer | ok | — | — | — |
| none-queue-current | no-answer | ok | — | — | — |
| none-scattered-words | no-answer | ok | — | — | owner-billing |
| dup-timeout | duplicate | ok | 1 | 1.000 | timeout-a, timeout-b |
| contra-audit | duplicate | ok | 1 | 1.000 | audit-365, audit-90, log-format |
| reject-no-terms | error | expected-error (ValidationFailed) | — | — | — |
| reject-limit | error | expected-error (ValidationFailed) | — | — | — |
| reject-state | error | expected-error (ValidationFailed) | — | — | — |

## heldout.json queries under the best configuration

| Query | Category | Outcome | First relevant rank | Recall@10 | Returned (top 5) |
| --- | --- | --- | --- | --- | --- |
| held-para-key-renewal | paraphrase | ok | 1 | 1.000 | api-token-ttl, beta-token-ttl |
| held-para-invoice-backlog | paraphrase | ok | 1 | 1.000 | error-e4012 |
| held-para-schema-signoff | paraphrase | ok | 1 | 1.000 | owner-billing |
| held-para-backup-retention | paraphrase | ok | 1 | 1.000 | backup-schedule |
| held-para-oncall-handover | paraphrase | ok | 1 | 1.000 | on-call, api-token-ttl |
| held-para-log-request-id | paraphrase | ok | 1 | 1.000 | log-format, arch-overview |
| held-para-failover-steps | paraphrase | ok | 1 | 1.000 | failover-current |
| held-para-reindex-blocker | paraphrase | ok | 1 | 1.000 | ticket-alp-1182 |
| held-para-stale-totals | paraphrase | ok | 1 | 1.000 | price-cache |
| held-correct-session-engine | correction | ok | 1 | 1.000 | db-engine-v2, backup-schedule, beta-session-plan |
| held-correct-release-afternoon | correction | ok | 1 | 1.000 | release-day, noise-release-notes |
| held-correct-shared-broker | correction | ok | 1 | 1.000 | queue-v2 |
| held-correct-staging-name | correction | ok | 1 | 1.000 | staging-current |
| held-noise-token-expiry | distractor | ok | 1 | 1.000 | api-token-ttl, beta-token-ttl, noise-token-ui |
| held-noise-session-storage | distractor | ok | 1 | 1.000 | db-engine-v2, beta-session-plan |
| held-noise-nightly-backups | distractor | ok | 1 | 1.000 | backup-schedule, noise-backup-ui |
| held-noise-e4012-restart | distractor | ok | 1 | 1.000 | error-e4012 |
| held-noise-release-schedule | distractor | ok | 1 | 1.000 | release-day, noise-release-notes |
| held-none-cdn | no-answer | ok | — | — | — |
| held-none-gamma-owner | no-answer | ok | — | — | owner-billing |
| held-none-certificate | no-answer | ok | — | — | api-token-ttl, beta-token-ttl |
| held-none-beta-backups | no-answer | ok | — | — | backup-schedule |

## heldout-2.json queries under the best configuration

| Query | Category | Outcome | First relevant rank | Recall@10 | Returned (top 5) |
| --- | --- | --- | --- | --- | --- |
| held2-para-credential-swap | paraphrase | ok | 1 | 1.000 | api-token-ttl |
| held2-para-invoicing-backlog | paraphrase | ok | — | 0.000 | — |
| held2-para-payments-owner | paraphrase | ok | — | 0.000 | — |
| held2-para-restore-window | paraphrase | ok | — | 0.000 | — |
| held2-para-pager-handoff | paraphrase | ok | — | 0.000 | — |
| held2-para-switch-capabilities | paraphrase | ok | — | 0.000 | — |
| held2-para-machine-readable | paraphrase | ok | 1 | 1.000 | log-format |
| held2-para-zone-outage | paraphrase | ok | — | 0.000 | — |
| held2-para-rebuild-waiting | paraphrase | ok | — | 0.000 | arch-overview |
| held2-para-cost-memory | paraphrase | ok | 1 | 1.000 | price-cache |
| held2-para-login-state | paraphrase | ok | — | 0.000 | audit-365 |
| held2-para-version-weekday | paraphrase | ok | — | 0.000 | backup-schedule |
| held2-para-request-give-up | paraphrase | ok | — | 0.000 | — |
| held2-para-event-streaming | paraphrase | ok | 1 | 1.000 | queue-v2 |
| held2-noise-rotating-tokens | distractor | ok | 1 | 1.000 | api-token-ttl, on-call, noise-token-ui |
| held2-noise-backup-retention | distractor | ok | 1 | 1.000 | backup-schedule, noise-backup-ui |
| held2-noise-release-day | distractor | ok | 1 | 1.000 | release-day, noise-release-notes, backup-schedule |
| held2-noise-checkout-cache | distractor | ok | 1 | 1.000 | price-cache, noise-browser-cache |
| held2-noise-billing-queue | distractor | ok | 1 | 1.000 | error-e4012 |
| held2-noise-session-engine | distractor | ok | 1 | 1.000 | db-engine-v2, noise-session-ui |
| held2-noise-beta-tokens | distractor | ok | 1 | 1.000 | beta-token-ttl, api-token-ttl |
| held2-none-refunds | no-answer | ok | — | — | — |
| held2-none-password-reset | no-answer | ok | — | — | — |
| held2-none-beta-replicas | no-answer | ok | — | — | — |
| held2-none-gamma-oncall | no-answer | ok | — | — | on-call |
| held2-none-beta-schema | no-answer | ok | — | — | owner-billing |
| held2-none-beta-releases | no-answer | ok | — | — | release-day |
| held2-none-rate-limit | no-answer | ok | — | — | — |
| held2-none-delta-warehouse | no-answer | ok | — | — | — |
| held2-none-push | no-answer | ok | — | — | — |
| held2-none-encryption | no-answer | ok | — | — | db-engine-v2 |
| held2-none-beta-audit | no-answer | ok | — | — | audit-90, audit-365 |
| held2-none-graphql | no-answer | ok | — | — | — |
| held2-none-search-pm | no-answer | ok | — | — | arch-summary, arch-overview, ticket-alp-1182 |

## Costs per reranker

Cold start is a new process importing the runtime, loading the reranker and scoring one pair, 5 times. Scoring is every corpus query's candidates at each depth in one batch, 5 times; for the fused source it includes embedding the query with Xenova/all-MiniLM-L6-v2. A query with fewer candidates than the depth scores what it has.

| Reranker | Size on disk | Cold start p50 / p95 (ms) | S17 retrieve, depth 10 p50 / p95 (ms) | S17 retrieve, depth 20 p50 / p95 (ms) | S17 retrieve, depth 50 p50 / p95 (ms) | S17, any-word share, depth 10 p50 / p95 (ms) | S17, any-word share, depth 20 p50 / p95 (ms) | S17, any-word share, depth 50 p50 / p95 (ms) | RRF of any-word and vector ≥ 0.30, depth 10 p50 / p95 (ms) | RRF of any-word and vector ≥ 0.30, depth 20 p50 / p95 (ms) | RRF of any-word and vector ≥ 0.30, depth 50 p50 / p95 (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Xenova/ms-marco-MiniLM-L-6-v2 | 87.5 MiB | 456.5 / 826.7 | 11.3 / 68.9 | 8.92 / 32.9 | 7.44 / 18.0 | 15.1 / 1018.8 | 17.8 / 2161.7 | 15.8 / 2560.9 | 42.6 / 964.8 | 95.6 / 2475.8 | 77.9 / 2292.1 |
| Xenova/ms-marco-TinyBERT-L-2-v2 | 17.5 MiB | 309.4 / 2007.6 | 0.87 / 3.28 | 0.78 / 1.71 | 0.71 / 1.49 | 1.01 / 91.2 | 0.98 / 126.8 | 0.98 / 160.0 | 6.48 / 141.2 | 16.8 / 252.7 | 13.8 / 274.9 |

## Notes

- Reranked results are ranked here, outside retrieve, so their response bytes and latency are not measured; model time stands for the added cost.
- A pair longer than a reranker's 512 tokens is truncated; the memory's start is kept.
- The reference rows are S17 lexical and S18's best rule; neither is a candidate for the choice.
