# Retrieval evaluation

Commit `fd99f7f3c97b759bf4ae264ca0608b8f1f52e6a9` (with uncommitted changes). Node v26.12.1 on win32 x64, 11th Gen Intel(R) Core(TM) i7-11850H @ 2.50GHz. Each query ran 5 time(s); the first run is scored.

Queries without their own limit run at limit 10. Bytes are the UTF-8 length of each response as JSON. Tokens are estimated as ceil(bytes / 4), not counted by a tokenizer. Latency is per successful call, in process. Cold start is open plus one search, in process, on a closed store. Duplicates are reported, not scored or gated; each expected result counts once. A fetch is needed for a relevant result that came back without its whole content: a truncated retrieve excerpt, or content that differs from the expected revision.

retrieve runs every query with text, at the default excerpt of 280 code points; `reject-limit` expects `ValidationFailed` from it, since retrieve bounds its limit itself. It matches any of the query's words in a stemmed index and keeps what its precision rule keeps: without stopwords, share ≥ 0.5, cut 0.35.

## Thresholds

Recorded in `design/90-decisions.md` (2026-10-27) before the first run; the retrieve response thresholds are S15.7, and retrieve is held to the search thresholds by S17.3 and S17.4. Hard thresholds gate CI; targets are reported, not gated. These queries chose the precision rule, so retrieve's results on them are fitted.

| Threshold | Kind | Judged at filler | Limit | Measured | Met |
| --- | --- | --- | --- | --- | --- |
| unauthorized exposure | hard | 0 | = 0 | 0 | yes |
| obsolete results in current answers | hard | 0 | = 0 | 0 | yes |
| unexpected, wrong or missing errors | hard | 0 | = 0 | 0 | yes |
| exact-identifier recall@5 | target | 0 | = 1.0 | 1 | yes |
| overall recall@10 | target | 0 | ≥ 0.90 | 0.735 | **no** |
| paraphrase recall@10 | target | 0 | ≥ 0.70 | 0 | **no** |
| overall MRR | target | 0 | ≥ 0.75 | 0.691 | **no** |
| mean non-relevant items in top 10 | target | 0 | ≤ 2 | 0.147 | yes |
| no-answer queries returning anything | target | 0 | ≤ 20% | 0 | yes |
| search p95 (ms) | target | 10,000 | ≤ 50 | 8.163 | yes |
| response bytes p95 | target | 10,000 | ≤ 32 KiB | 5265 | yes |
| cold start p95 (ms) | target | 10,000 | ≤ 500 | 27.475 | yes |
| retrieve response bytes p95 | target | 10,000 | ≤ 32 KiB | 5429 | yes |
| retrieve large-content response bytes | hard | 10,000 | ≤ 64 KiB | 1157 | yes |
| retrieve unauthorized exposure | hard | 0 | = 0 | 0 | yes |
| retrieve obsolete results in current answers | hard | 0 | = 0 | 0 | yes |
| retrieve unexpected, wrong or missing errors | hard | 0 | = 0 | 0 | yes |
| retrieve exact-identifier recall@5 | target | 0 | = 1.0 | 1 | yes |
| retrieve overall recall@10 | target | 0 | ≥ 0.90 | 0.909 | yes |
| retrieve paraphrase recall@10 | target | 0 | ≥ 0.70 | 0.714 | yes |
| retrieve overall MRR | target | 0 | ≥ 0.75 | 0.870 | yes |
| retrieve mean non-relevant items in top 10 | target | 0 | ≤ 2 | 0.697 | yes |
| retrieve no-answer queries returning anything | target | 0 | ≤ 20% | 0.500 | **no** |
| retrieve p95 (ms) | target | 10,000 | ≤ 50 | 45.967 | yes |

## Held-out queries

Written in `heldout.json` before any S17 code ran against the corpus and never used to choose a parameter. They run against the same store as the corpus queries.

| Threshold | Kind | Judged at filler | Limit | Measured | Met |
| --- | --- | --- | --- | --- | --- |
| retrieve unauthorized exposure | hard | 0 | = 0 | 0 | yes |
| retrieve obsolete results in current answers | hard | 0 | = 0 | 0 | yes |
| retrieve unexpected, wrong or missing errors | hard | 0 | = 0 | 0 | yes |
| retrieve exact-identifier recall@5 | target | 0 | = 1.0 | no such queries | — |
| retrieve overall recall@10 | target | 0 | ≥ 0.90 | 0.944 | yes |
| retrieve paraphrase recall@10 | target | 0 | ≥ 0.70 | 1 | yes |
| retrieve overall MRR | target | 0 | ≥ 0.75 | 0.917 | yes |
| retrieve mean non-relevant items in top 10 | target | 0 | ≤ 2 | 0.333 | yes |
| retrieve no-answer queries returning anything | target | 0 | ≤ 20% | 0.500 | **no** |

## Precision rules

retrieve under each rule compared for S17.2, over the corpus queries without filler. A memory is kept when it holds at least the share of the query's words and scores at least the cut times the best kept score; stopwords are dropped from the query unless nothing else is left. The rule chosen has the highest recall@10, then MRR, then the fewest non-relevant results.

| Rule | Exact recall@5 | Recall@10 | Paraphrase recall@10 | MRR | Non-relevant in top 10 | No-answer returned | Obsolete | Exposure | Errors |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| with stopwords, share ≥ 0, cut 0 | 1.000 | 0.970 | 0.857 | 0.892 | 5.82 | 1.000 | 0 | 0 | 0 |
| without stopwords, share ≥ 0, cut 0 | 1.000 | 0.970 | 0.857 | 0.910 | 5.15 | 0.750 | 0 | 0 | 0 |
| without stopwords, share ≥ 0.5, cut 0 | 1.000 | 0.909 | 0.714 | 0.870 | 1.61 | 0.500 | 0 | 0 | 0 |
| without stopwords, share ≥ 0.67, cut 0 | 1.000 | 0.758 | 0.000 | 0.742 | 0.15 | 0.000 | 0 | 0 | 0 |
| without stopwords, share ≥ 1, cut 0 | 1.000 | 0.727 | 0.000 | 0.712 | 0.15 | 0.000 | 0 | 0 | 0 |
| without stopwords, share ≥ 0, cut 0.35 | 1.000 | 0.970 | 0.857 | 0.910 | 1.39 | 0.750 | 0 | 0 | 0 |
| without stopwords, share ≥ 0.5, cut 0.2 | 1.000 | 0.909 | 0.714 | 0.870 | 0.70 | 0.500 | 0 | 0 | 0 |
| without stopwords, share ≥ 0.5, cut 0.35 (chosen) | 1.000 | 0.909 | 0.714 | 0.870 | 0.70 | 0.500 | 0 | 0 | 0 |
| without stopwords, share ≥ 0.5, cut 0.5 | 1.000 | 0.909 | 0.714 | 0.870 | 0.45 | 0.500 | 0 | 0 | 0 |
| with stopwords, share ≥ 0.5, cut 0.35 | 1.000 | 0.818 | 0.286 | 0.803 | 0.61 | 0.500 | 0 | 0 | 0 |

## 0 filler notes

| Category | Queries | Recall@5 | Recall@10 | MRR | nDCG@10 | Non-relevant in top 10 | No-answer returned | Obsolete | Exposure | Errors | Duplicates | Fetches needed | Pages (partial) | Latency p50 / p95 (ms) | Bytes per response p50 / p95 / max |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| overall | 42 | 0.735 | 0.735 | 0.691 | 0.703 | 0.15 | 0.000 | 0 | 0 | 0 | 1 | 0 | 41 (3) | 0.28 / 0.44 | 472 / 982 / 189320 |
| exact | 4 | 1.000 | 1.000 | 1.000 | 1.000 | 0.00 | — | 0 | 0 | 0 | 0 | 0 | 4 (0) | 0.29 / 0.39 | 472 / 500 / 500 |
| paraphrase | 7 | 0.000 | 0.000 | 0.000 | 0.000 | 0.00 | — | 0 | 0 | 0 | 0 | 0 | 7 (0) | 0.21 / 0.24 | 56 / 56 / 56 |
| correction | 5 | 0.600 | 0.600 | 0.600 | 0.600 | 0.00 | — | 0 | 0 | 0 | 0 | 0 | 5 (0) | 0.30 / 0.36 | 467 / 561 / 561 |
| historical | 2 | 1.000 | 1.000 | 1.000 | 1.000 | 0.00 | — | 0 | 0 | 0 | 0 | 0 | 2 (0) | 0.35 / 0.43 | 920 / 1006 / 1006 |
| lifecycle | 4 | 1.000 | 1.000 | 1.000 | 1.000 | 0.00 | — | 0 | 0 | 0 | 0 | 0 | 4 (0) | 0.29 / 0.52 | 480 / 485 / 485 |
| distractor | 5 | 1.000 | 1.000 | 0.700 | 0.779 | 1.00 | — | 0 | 0 | 0 | 0 | 0 | 5 (0) | 0.31 / 0.42 | 897 / 982 / 982 |
| cross-namespace | 4 | 1.000 | 1.000 | 1.000 | 1.000 | 0.00 | — | 0 | 0 | 0 | 0 | 0 | 3 (0) | 0.32 / 0.42 | 481 / 561 / 561 |
| sparse-filter | 1 | 1.000 | 1.000 | 1.000 | 1.000 | 0.00 | — | 0 | 0 | 0 | 0 | 0 | 4 (3) | 0.16 / 0.31 | 282 / 921 / 921 |
| large-content | 1 | 1.000 | 1.000 | 1.000 | 1.000 | 0.00 | — | 0 | 0 | 0 | 0 | 0 | 1 (0) | 0.62 / 0.73 | 189320 / 189320 / 189320 |
| no-answer | 4 | 0.000 | 0.000 | 0.000 | 0.000 | 0.00 | 0.000 | 0 | 0 | 0 | 0 | 0 | 4 (0) | 0.19 / 0.21 | 56 / 56 / 56 |
| duplicate | 2 | 1.000 | 1.000 | 1.000 | 1.000 | 0.00 | — | 0 | 0 | 0 | 1 | 0 | 2 (0) | 0.34 / 0.36 | 820 / 821 / 821 |
| error | 3 | 0.000 | 0.000 | 0.000 | 0.000 | 0.00 | — | 0 | 0 | 0 | 0 | 0 | 0 (0) | 0.00 / 0.00 | 0 / 0 / 0 |

search and retrieve, over the queries with text:

| Operation | Queries | Recall@10 | MRR | Obsolete | Exposure | Errors | Fetches needed | Fetches per answerable query | Pages (partial) | Latency p50 / p95 (ms) | Bytes per response p50 / p95 / max | Large-content bytes max |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| search | 41 | 0.727 | 0.682 | 0 | 0 | 0 | 0 | 0.000 | 37 (0) | 0.29 / 0.44 | 480 / 1006 / 189320 | 189,320 |
| retrieve | 41 | 0.909 | 0.870 | 0 | 0 | 0 | 1 | 0.030 | 37 (0) | 0.65 / 1.13 | 508 / 1807 / 2090 | 1,155 |

Held-out queries:

| Category | Queries | Recall@5 | Recall@10 | MRR | nDCG@10 | Non-relevant in top 10 | No-answer returned | Obsolete | Exposure | Errors | Duplicates | Fetches needed | Pages (partial) | Latency p50 / p95 (ms) | Bytes per response p50 / p95 / max |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| search | 22 | 0.056 | 0.056 | 0.056 | 0.056 | 0.00 | 0.000 | 0 | 0 | 0 | 0 | 0 | 22 (0) | 0.21 / 0.29 | 56 / 56 / 471 |
| retrieve | 22 | 0.944 | 0.944 | 0.917 | 0.924 | 0.33 | 0.500 | 0 | 0 | 0 | 0 | 0 | 22 (0) | 0.78 / 1.46 | 492 / 930 / 1153 |
| retrieve, paraphrase | 9 | 1.000 | 1.000 | 1.000 | 1.000 | 0.11 | — | 0 | 0 | 0 | 0 | 0 | 9 (0) | 0.98 / 3.13 | 497 / 1153 / 1153 |
| retrieve, correction | 4 | 0.750 | 0.750 | 0.750 | 0.750 | 0.25 | — | 0 | 0 | 0 | 0 | 0 | 4 (0) | 0.83 / 1.24 | 467 / 909 / 909 |
| retrieve, distractor | 5 | 1.000 | 1.000 | 0.900 | 0.926 | 0.80 | — | 0 | 0 | 0 | 0 | 0 | 5 (0) | 0.68 / 0.99 | 909 / 930 / 930 |
| retrieve, no-answer | 4 | 0.000 | 0.000 | 0.000 | 0.000 | 0.00 | 0.500 | 0 | 0 | 0 | 0 | 0 | 4 (0) | 0.45 / 1.00 | 56 / 488 / 488 |

| Cost | Value |
| --- | --- |
| memories written | 72 |
| create p50 / p95 (ms) | 2.62 / 4.69 |
| lifecycle step p50 / p95 (ms) | 3.03 / 3.95 |
| build and check (s) | 0.2 |
| database with WAL | 1.1 MiB |
| cold start p50 / p95 (ms) | 2.70 / 3.96 |
| response bytes p95 | 982 B (~246 tokens) |
| response bytes max | 189,320 B (~47,330 tokens) |

## 10,000 filler notes

| Category | Queries | Recall@5 | Recall@10 | MRR | nDCG@10 | Non-relevant in top 10 | No-answer returned | Obsolete | Exposure | Errors | Duplicates | Fetches needed | Pages (partial) | Latency p50 / p95 (ms) | Bytes per response p50 / p95 / max |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| overall | 42 | 0.618 | 0.618 | 0.588 | 0.596 | 1.29 | 0.000 | 0 | 0 | 0 | 1 | 0 | 41 (3) | 0.62 / 8.16 | 472 / 5265 / 189320 |
| exact | 4 | 1.000 | 1.000 | 1.000 | 1.000 | 0.00 | — | 0 | 0 | 0 | 0 | 0 | 4 (0) | 0.31 / 0.38 | 472 / 500 / 500 |
| paraphrase | 7 | 0.000 | 0.000 | 0.000 | 0.000 | 0.00 | — | 0 | 0 | 0 | 0 | 0 | 7 (0) | 0.27 / 0.43 | 56 / 56 / 56 |
| correction | 5 | 0.400 | 0.400 | 0.400 | 0.400 | 2.00 | — | 0 | 0 | 0 | 0 | 0 | 5 (0) | 0.51 / 6.45 | 467 / 5235 / 5235 |
| historical | 2 | 0.500 | 0.500 | 0.500 | 0.500 | 5.00 | — | 0 | 0 | 0 | 0 | 0 | 2 (0) | 1.65 / 8.16 | 920 / 5235 / 5235 |
| lifecycle | 4 | 1.000 | 1.000 | 1.000 | 1.000 | 0.00 | — | 0 | 0 | 0 | 0 | 0 | 4 (0) | 0.96 / 1.38 | 480 / 485 / 485 |
| distractor | 5 | 0.800 | 0.800 | 0.600 | 0.652 | 2.80 | — | 0 | 0 | 0 | 0 | 0 | 5 (0) | 1.13 / 15.01 | 897 / 5295 / 5295 |
| cross-namespace | 4 | 0.667 | 0.667 | 0.667 | 0.667 | 3.33 | — | 0 | 0 | 0 | 0 | 0 | 3 (0) | 1.08 / 14.90 | 481 / 5265 / 5265 |
| sparse-filter | 1 | 1.000 | 1.000 | 1.000 | 1.000 | 0.00 | — | 0 | 0 | 0 | 0 | 0 | 4 (3) | 0.14 / 0.28 | 282 / 921 / 921 |
| large-content | 1 | 1.000 | 1.000 | 1.000 | 1.000 | 0.00 | — | 0 | 0 | 0 | 0 | 0 | 1 (0) | 1.63 / 1.81 | 189320 / 189320 / 189320 |
| no-answer | 4 | 0.000 | 0.000 | 0.000 | 0.000 | 0.00 | 0.000 | 0 | 0 | 0 | 0 | 0 | 4 (0) | 0.49 / 0.83 | 56 / 56 / 56 |
| duplicate | 2 | 1.000 | 1.000 | 1.000 | 1.000 | 0.00 | — | 0 | 0 | 0 | 1 | 0 | 2 (0) | 1.12 / 1.27 | 820 / 821 / 821 |
| error | 3 | 0.000 | 0.000 | 0.000 | 0.000 | 0.00 | — | 0 | 0 | 0 | 0 | 0 | 0 (0) | 0.00 / 0.00 | 0 / 0 / 0 |

search and retrieve, over the queries with text:

| Operation | Queries | Recall@10 | MRR | Obsolete | Exposure | Errors | Fetches needed | Fetches per answerable query | Pages (partial) | Latency p50 / p95 (ms) | Bytes per response p50 / p95 / max | Large-content bytes max |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| search | 41 | 0.606 | 0.576 | 0 | 0 | 0 | 0 | 0.000 | 37 (0) | 0.81 / 14.18 | 480 / 5295 / 189320 | 189,320 |
| retrieve | 41 | 0.667 | 0.652 | 0 | 0 | 0 | 1 | 0.030 | 37 (0) | 15.40 / 45.97 | 496 / 5429 / 5462 | 1,157 |

Held-out queries:

| Category | Queries | Recall@5 | Recall@10 | MRR | nDCG@10 | Non-relevant in top 10 | No-answer returned | Obsolete | Exposure | Errors | Duplicates | Fetches needed | Pages (partial) | Latency p50 / p95 (ms) | Bytes per response p50 / p95 / max |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| search | 22 | 0.056 | 0.056 | 0.056 | 0.056 | 0.00 | 0.000 | 0 | 0 | 0 | 0 | 0 | 22 (0) | 0.34 / 0.92 | 56 / 56 / 471 |
| retrieve | 22 | 0.778 | 0.778 | 0.778 | 0.778 | 1.72 | 0.500 | 0 | 0 | 0 | 0 | 0 | 22 (0) | 8.75 / 30.05 | 490 / 5452 / 5452 |
| retrieve, paraphrase | 9 | 1.000 | 1.000 | 1.000 | 1.000 | 0.11 | — | 0 | 0 | 0 | 0 | 0 | 9 (0) | 7.67 / 18.84 | 496 / 1151 / 1151 |
| retrieve, correction | 4 | 0.500 | 0.500 | 0.500 | 0.500 | 2.50 | — | 0 | 0 | 0 | 0 | 0 | 4 (0) | 15.88 / 28.93 | 467 / 5452 / 5452 |
| retrieve, distractor | 5 | 0.600 | 0.600 | 0.600 | 0.600 | 4.00 | — | 0 | 0 | 0 | 0 | 0 | 5 (0) | 25.36 / 40.79 | 528 / 5452 / 5452 |
| retrieve, no-answer | 4 | 0.000 | 0.000 | 0.000 | 0.000 | 0.00 | 0.500 | 0 | 0 | 0 | 0 | 0 | 4 (0) | 4.38 / 7.18 | 56 / 489 / 489 |

| Cost | Value |
| --- | --- |
| memories written | 10,072 |
| create p50 / p95 (ms) | 3.30 / 7.77 |
| lifecycle step p50 / p95 (ms) | 8.20 / 16.59 |
| build and check (s) | 40.9 |
| database with WAL | 20.3 MiB |
| cold start p50 / p95 (ms) | 25.56 / 27.48 |
| response bytes p95 | 5,265 B (~1,317 tokens) |
| response bytes max | 189,320 B (~47,330 tokens) |

## Queries at 0 filler notes

| Query | Category | Outcome | First relevant rank | Recall@10 | Fetches needed, search / retrieve | Returned (top 5) |
| --- | --- | --- | --- | --- | --- | --- |
| exact-error-code | exact | ok | 1 | 1.000 | 0 / 0 | error-e4012 |
| exact-ticket | exact | ok | 1 | 1.000 | 0 / 0 | ticket-alp-1182 |
| exact-person | exact | ok | 1 | 1.000 | 0 / 0 | owner-billing |
| exact-cluster | exact | ok | 1 | 1.000 | 0 / 0 | staging-current |
| para-token-lifetime | paraphrase | ok | — | 0.000 | 0 / 0 | — |
| para-price-cache | paraphrase | ok | — | 0.000 | 0 / 0 | — |
| para-billing-owner | paraphrase | ok | — | 0.000 | 0 / 0 | — |
| para-snapshots | paraphrase | ok | — | 0.000 | 0 / 0 | — |
| para-rotation-day | paraphrase | ok | — | 0.000 | 0 / 0 | — |
| para-toggles | paraphrase | ok | — | 0.000 | 0 / 0 | — |
| para-log-shape | paraphrase | ok | — | 0.000 | 0 / 0 | — |
| correct-release-new | correction | ok | 1 | 1.000 | 0 / 0 | release-day |
| correct-release-stale | correction | ok | — | 0.000 | 0 / 0 | — |
| correct-session-store | correction | ok | 1 | 1.000 | 0 / 0 | db-engine-v2 |
| correct-postgres | correction | ok | 1 | 1.000 | 0 / 0 | db-engine-v2 |
| correct-rabbitmq | correction | ok | — | 0.000 | 0 / 0 | — |
| history-session-store | historical | ok | 1 | 1.000 | 0 / 0 | db-engine-v1, db-engine-v2 |
| history-queue | historical | ok | 1 | 1.000 | 0 / 0 | queue-v1, queue-v2 |
| state-failover-default | lifecycle | ok | 1 | 1.000 | 0 / 0 | failover-current |
| state-failover-archived | lifecycle | ok | 1 | 1.000 | 0 / 0 | failover-old |
| state-staging-default | lifecycle | ok | 1 | 1.000 | 0 / 0 | staging-current |
| state-staging-tombstoned | lifecycle | ok | 1 | 1.000 | 0 / 0 | staging-old |
| noise-tokens | distractor | ok | 2 | 1.000 | 0 / 0 | noise-token-ui, api-token-ttl |
| noise-release | distractor | ok | 1 | 1.000 | 0 / 0 | release-day, noise-release-notes |
| noise-backup | distractor | ok | 1 | 1.000 | 0 / 0 | backup-schedule, noise-backup-ui |
| noise-stale-cache | distractor | ok | 2 | 1.000 | 0 / 0 | noise-browser-cache, price-cache |
| noise-session | distractor | ok | 2 | 1.000 | 0 / 0 | noise-session-ui, db-engine-v2 |
| scope-tokens | cross-namespace | ok | 1 | 1.000 | 0 / 0 | api-token-ttl |
| scope-session | cross-namespace | ok | 1 | 1.000 | 0 / 0 | db-engine-v2 |
| scope-queue-history | cross-namespace | ok | 1 | 1.000 | 0 / 0 | queue-v1 |
| scope-named-foreign | cross-namespace | expected-error (Forbidden) | — | — | expected-error / expected-error | — |
| sparse-sev1 | sparse-filter | ok | 1 | 1.000 | 0 / — | ops-sev1-dns, ops-sev1-disk |
| large-architecture | large-content | ok | 1 | 1.000 | 0 / 1 | arch-overview, arch-summary |
| none-autoscaling | no-answer | ok | — | — | 0 / 0 | — |
| none-budget | no-answer | ok | — | — | 0 / 0 | — |
| none-queue-current | no-answer | ok | — | — | 0 / 0 | — |
| none-scattered-words | no-answer | ok | — | — | 0 / 0 | — |
| dup-timeout | duplicate | ok | 1 | 1.000 | 0 / 0 | timeout-a, timeout-b |
| contra-audit | duplicate | ok | 1 | 1.000 | 0 / 0 | audit-90, audit-365 |
| reject-no-terms | error | expected-error (ValidationFailed) | — | — | expected-error / expected-error | — |
| reject-limit | error | expected-error (LimitExceeded) | — | — | expected-error / expected-error | — |
| reject-state | error | expected-error (ValidationFailed) | — | — | expected-error / expected-error | — |

## Held-out queries through retrieve at 0 filler notes

| Query | Category | Outcome | First relevant rank | Recall@10 | Returned (top 5) |
| --- | --- | --- | --- | --- | --- |
| held-para-key-renewal | paraphrase | ok | 1 | 1.000 | api-token-ttl |
| held-para-invoice-backlog | paraphrase | ok | 1 | 1.000 | error-e4012 |
| held-para-schema-signoff | paraphrase | ok | 1 | 1.000 | owner-billing |
| held-para-backup-retention | paraphrase | ok | 1 | 1.000 | backup-schedule |
| held-para-oncall-handover | paraphrase | ok | 1 | 1.000 | on-call |
| held-para-log-request-id | paraphrase | ok | 1 | 1.000 | log-format, arch-overview |
| held-para-failover-steps | paraphrase | ok | 1 | 1.000 | failover-current |
| held-para-reindex-blocker | paraphrase | ok | 1 | 1.000 | ticket-alp-1182 |
| held-para-stale-totals | paraphrase | ok | 1 | 1.000 | price-cache |
| held-correct-session-engine | correction | ok | — | 0.000 | — |
| held-correct-release-afternoon | correction | ok | 1 | 1.000 | release-day, noise-release-notes |
| held-correct-shared-broker | correction | ok | 1 | 1.000 | queue-v2 |
| held-correct-staging-name | correction | ok | 1 | 1.000 | staging-current |
| held-noise-token-expiry | distractor | ok | 2 | 1.000 | noise-token-ui, api-token-ttl |
| held-noise-session-storage | distractor | ok | 1 | 1.000 | db-engine-v2, beta-session-plan |
| held-noise-nightly-backups | distractor | ok | 1 | 1.000 | backup-schedule, noise-backup-ui |
| held-noise-e4012-restart | distractor | ok | 1 | 1.000 | error-e4012 |
| held-noise-release-schedule | distractor | ok | 1 | 1.000 | release-day, noise-release-notes |
| held-none-cdn | no-answer | ok | — | — | — |
| held-none-gamma-owner | no-answer | ok | — | — | — |
| held-none-certificate | no-answer | ok | — | — | api-token-ttl |
| held-none-beta-backups | no-answer | ok | — | — | backup-schedule |

## Known gaps

- Search matches every word exactly, with no stemming; retrieve matches any word under Porter stemming. Neither has synonyms, so a paraphrase that shares no stem with the memory is not found.
- retrieve's precision rule is lexical: a no-answer query that shares half its words with a memory still returns it.
- An earlier revision of a memory updated in place is reachable through `revision()`, not search; historical queries cover superseded memories only.
- The large-content search returns one memory larger than the 32 KiB response target; the target is judged at p95, and the max is shown beside it. retrieve returns an excerpt of it, within the 64 KiB bound, and the full record takes a `get`.
- Sparse metadata filters are measured as pages and partial pages at a scan budget of 10; storage does not report rows scanned.
