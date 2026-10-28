# Retrieval evaluation

Commit `abfad3a8d020ff94f51b80804bc0c1e75954caf5`. Node v26.12.1 on win32 x64, 11th Gen Intel(R) Core(TM) i7-11850H @ 2.50GHz. Each query ran 5 time(s); the first run is scored.

Queries without their own limit run at limit 10. Bytes are the UTF-8 length of each response as JSON. Tokens are estimated as ceil(bytes / 4), not counted by a tokenizer. Latency is per successful call, in process. Cold start is open plus one search, in process, on a closed store. Duplicates are reported, not scored or gated; each expected result counts once. A fetch is needed for a relevant result that came back without its whole content: a truncated retrieve excerpt, or content that differs from the expected revision.

retrieve runs every query with text, at the default excerpt of 280 code points; `reject-limit` expects `ValidationFailed` from it, since retrieve bounds its limit itself.

## Thresholds

Recorded in `design/90-decisions.md` (2026-10-27) before the first run; the retrieve thresholds are S15.7. Hard thresholds gate CI; targets are reported, not gated.

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
| search p95 (ms) | target | 10,000 | ≤ 50 | 12.295 | yes |
| response bytes p95 | target | 10,000 | ≤ 32 KiB | 5265 | yes |
| cold start p95 (ms) | target | 10,000 | ≤ 500 | 44.577 | yes |
| retrieve response bytes p95 | target | 10,000 | ≤ 32 KiB | 5395 | yes |
| retrieve large-content response bytes | hard | 10,000 | ≤ 64 KiB | 1157 | yes |

## 0 filler notes

| Category | Queries | Recall@5 | Recall@10 | MRR | nDCG@10 | Non-relevant in top 10 | No-answer returned | Obsolete | Exposure | Errors | Duplicates | Fetches needed | Pages (partial) | Latency p50 / p95 (ms) | Bytes per response p50 / p95 / max |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| overall | 42 | 0.735 | 0.735 | 0.691 | 0.703 | 0.15 | 0.000 | 0 | 0 | 0 | 1 | 0 | 41 (3) | 0.31 / 0.47 | 472 / 982 / 189320 |
| exact | 4 | 1.000 | 1.000 | 1.000 | 1.000 | 0.00 | — | 0 | 0 | 0 | 0 | 0 | 4 (0) | 0.33 / 0.43 | 472 / 500 / 500 |
| paraphrase | 7 | 0.000 | 0.000 | 0.000 | 0.000 | 0.00 | — | 0 | 0 | 0 | 0 | 0 | 7 (0) | 0.26 / 0.34 | 56 / 56 / 56 |
| correction | 5 | 0.600 | 0.600 | 0.600 | 0.600 | 0.00 | — | 0 | 0 | 0 | 0 | 0 | 5 (0) | 0.32 / 0.40 | 467 / 561 / 561 |
| historical | 2 | 1.000 | 1.000 | 1.000 | 1.000 | 0.00 | — | 0 | 0 | 0 | 0 | 0 | 2 (0) | 0.39 / 0.47 | 920 / 1006 / 1006 |
| lifecycle | 4 | 1.000 | 1.000 | 1.000 | 1.000 | 0.00 | — | 0 | 0 | 0 | 0 | 0 | 4 (0) | 0.30 / 0.39 | 480 / 485 / 485 |
| distractor | 5 | 1.000 | 1.000 | 0.700 | 0.779 | 1.00 | — | 0 | 0 | 0 | 0 | 0 | 5 (0) | 0.33 / 0.43 | 897 / 982 / 982 |
| cross-namespace | 4 | 1.000 | 1.000 | 1.000 | 1.000 | 0.00 | — | 0 | 0 | 0 | 0 | 0 | 3 (0) | 0.34 / 0.66 | 481 / 561 / 561 |
| sparse-filter | 1 | 1.000 | 1.000 | 1.000 | 1.000 | 0.00 | — | 0 | 0 | 0 | 0 | 0 | 4 (3) | 0.18 / 0.38 | 282 / 921 / 921 |
| large-content | 1 | 1.000 | 1.000 | 1.000 | 1.000 | 0.00 | — | 0 | 0 | 0 | 0 | 0 | 1 (0) | 1.14 / 1.32 | 189320 / 189320 / 189320 |
| no-answer | 4 | 0.000 | 0.000 | 0.000 | 0.000 | 0.00 | 0.000 | 0 | 0 | 0 | 0 | 0 | 4 (0) | 0.17 / 0.22 | 56 / 56 / 56 |
| duplicate | 2 | 1.000 | 1.000 | 1.000 | 1.000 | 0.00 | — | 0 | 0 | 0 | 1 | 0 | 2 (0) | 0.32 / 0.41 | 820 / 821 / 821 |
| error | 3 | 0.000 | 0.000 | 0.000 | 0.000 | 0.00 | — | 0 | 0 | 0 | 0 | 0 | 0 (0) | 0.00 / 0.00 | 0 / 0 / 0 |

search and retrieve, over the queries with text:

| Operation | Queries | Recall@10 | MRR | Obsolete | Exposure | Errors | Fetches needed | Fetches per answerable query | Pages (partial) | Latency p50 / p95 (ms) | Bytes per response p50 / p95 / max | Large-content bytes max |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| search | 41 | 0.727 | 0.682 | 0 | 0 | 0 | 0 | 0.000 | 37 (0) | 0.31 / 0.48 | 480 / 1006 / 189320 | 189,320 |
| retrieve | 41 | 0.727 | 0.682 | 0 | 0 | 0 | 1 | 0.030 | 37 (0) | 0.37 / 0.56 | 487 / 975 / 1155 | 1,155 |

| Cost | Value |
| --- | --- |
| memories written | 72 |
| create p50 / p95 (ms) | 0.98 / 1.73 |
| lifecycle step p50 / p95 (ms) | 1.40 / 5.36 |
| build and check (s) | 0.1 |
| database with WAL | 0.8 MiB |
| cold start p50 / p95 (ms) | 4.78 / 5.05 |
| response bytes p95 | 982 B (~246 tokens) |
| response bytes max | 189,320 B (~47,330 tokens) |

## 10,000 filler notes

| Category | Queries | Recall@5 | Recall@10 | MRR | nDCG@10 | Non-relevant in top 10 | No-answer returned | Obsolete | Exposure | Errors | Duplicates | Fetches needed | Pages (partial) | Latency p50 / p95 (ms) | Bytes per response p50 / p95 / max |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| overall | 42 | 0.618 | 0.618 | 0.588 | 0.596 | 1.29 | 0.000 | 0 | 0 | 0 | 1 | 0 | 41 (3) | 0.44 / 12.30 | 472 / 5265 / 189320 |
| exact | 4 | 1.000 | 1.000 | 1.000 | 1.000 | 0.00 | — | 0 | 0 | 0 | 0 | 0 | 4 (0) | 0.29 / 0.52 | 472 / 500 / 500 |
| paraphrase | 7 | 0.000 | 0.000 | 0.000 | 0.000 | 0.00 | — | 0 | 0 | 0 | 0 | 0 | 7 (0) | 0.23 / 0.37 | 56 / 56 / 56 |
| correction | 5 | 0.400 | 0.400 | 0.400 | 0.400 | 2.00 | — | 0 | 0 | 0 | 0 | 0 | 5 (0) | 0.45 / 10.15 | 467 / 5235 / 5235 |
| historical | 2 | 0.500 | 0.500 | 0.500 | 0.500 | 5.00 | — | 0 | 0 | 0 | 0 | 0 | 2 (0) | 0.94 / 13.05 | 920 / 5235 / 5235 |
| lifecycle | 4 | 1.000 | 1.000 | 1.000 | 1.000 | 0.00 | — | 0 | 0 | 0 | 0 | 0 | 4 (0) | 0.77 / 1.21 | 480 / 485 / 485 |
| distractor | 5 | 0.800 | 0.800 | 0.600 | 0.652 | 2.80 | — | 0 | 0 | 0 | 0 | 0 | 5 (0) | 0.87 / 18.18 | 897 / 5295 / 5295 |
| cross-namespace | 4 | 0.667 | 0.667 | 0.667 | 0.667 | 3.33 | — | 0 | 0 | 0 | 0 | 0 | 3 (0) | 0.68 / 17.43 | 481 / 5265 / 5265 |
| sparse-filter | 1 | 1.000 | 1.000 | 1.000 | 1.000 | 0.00 | — | 0 | 0 | 0 | 0 | 0 | 4 (3) | 0.22 / 0.42 | 282 / 921 / 921 |
| large-content | 1 | 1.000 | 1.000 | 1.000 | 1.000 | 0.00 | — | 0 | 0 | 0 | 0 | 0 | 1 (0) | 0.93 / 1.52 | 189320 / 189320 / 189320 |
| no-answer | 4 | 0.000 | 0.000 | 0.000 | 0.000 | 0.00 | 0.000 | 0 | 0 | 0 | 0 | 0 | 4 (0) | 0.26 / 0.34 | 56 / 56 / 56 |
| duplicate | 2 | 1.000 | 1.000 | 1.000 | 1.000 | 0.00 | — | 0 | 0 | 0 | 1 | 0 | 2 (0) | 0.67 / 0.81 | 820 / 821 / 821 |
| error | 3 | 0.000 | 0.000 | 0.000 | 0.000 | 0.00 | — | 0 | 0 | 0 | 0 | 0 | 0 (0) | 0.00 / 0.00 | 0 / 0 / 0 |

search and retrieve, over the queries with text:

| Operation | Queries | Recall@10 | MRR | Obsolete | Exposure | Errors | Fetches needed | Fetches per answerable query | Pages (partial) | Latency p50 / p95 (ms) | Bytes per response p50 / p95 / max | Large-content bytes max |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| search | 41 | 0.606 | 0.576 | 0 | 0 | 0 | 0 | 0.000 | 37 (0) | 0.52 / 12.82 | 480 / 5295 / 189320 | 189,320 |
| retrieve | 41 | 0.606 | 0.576 | 0 | 0 | 0 | 1 | 0.030 | 37 (0) | 0.98 / 18.59 | 486 / 5395 / 5395 | 1,157 |

| Cost | Value |
| --- | --- |
| memories written | 10,072 |
| create p50 / p95 (ms) | 3.49 / 8.52 |
| lifecycle step p50 / p95 (ms) | 11.32 / 22.80 |
| build and check (s) | 44.3 |
| database with WAL | 15.8 MiB |
| cold start p50 / p95 (ms) | 42.17 / 44.58 |
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

## Known gaps

- Search has no stemming or synonyms, so paraphrases that share no word with the memory are not found.
- An earlier revision of a memory updated in place is reachable through `revision()`, not search; historical queries cover superseded memories only.
- The large-content search returns one memory larger than the 32 KiB response target; the target is judged at p95, and the max is shown beside it. retrieve returns an excerpt of it, within the 64 KiB bound, and the full record takes a `get`.
- Sparse metadata filters are measured as pages and partial pages at a scan budget of 10; storage does not report rows scanned.
