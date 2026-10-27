# Retrieval evaluation

Commit `254bf73e4bbb349d7b240db154734b96b6210c7e`. Node v26.12.1 on win32 x64, 11th Gen Intel(R) Core(TM) i7-11850H @ 2.50GHz. Each query ran 5 time(s); the first run is scored.

Queries without their own limit run at limit 10. Bytes are the UTF-8 length of each search response as JSON. Tokens are estimated as ceil(bytes / 4), not counted by a tokenizer. Latency is per successful search call, in process. Cold start is open plus one search, in process, on a closed store. Duplicates are reported, not scored or gated; each expected result counts once.

## Thresholds

Recorded in `design/90-decisions.md` (2026-10-27) before the first run. Hard thresholds gate CI; targets are reported, not gated.

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
| search p95 (ms) | target | 10,000 | ≤ 50 | 14.507 | yes |
| response bytes p95 | target | 10,000 | ≤ 32 KiB | 5265 | yes |
| cold start p95 (ms) | target | 10,000 | ≤ 500 | 49.257 | yes |

## 0 filler notes

| Category | Queries | Recall@5 | Recall@10 | MRR | nDCG@10 | Non-relevant in top 10 | No-answer returned | Obsolete | Exposure | Errors | Duplicates | Fetches needed | Pages (partial) | Latency p50 / p95 (ms) | Bytes per response p50 / p95 / max |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| overall | 42 | 0.735 | 0.735 | 0.691 | 0.703 | 0.15 | 0.000 | 0 | 0 | 0 | 1 | 0 | 41 (3) | 0.59 / 1.25 | 472 / 982 / 189320 |
| exact | 4 | 1.000 | 1.000 | 1.000 | 1.000 | 0.00 | — | 0 | 0 | 0 | 0 | 0 | 4 (0) | 0.50 / 0.65 | 472 / 500 / 500 |
| paraphrase | 7 | 0.000 | 0.000 | 0.000 | 0.000 | 0.00 | — | 0 | 0 | 0 | 0 | 0 | 7 (0) | 0.44 / 0.59 | 56 / 56 / 56 |
| correction | 5 | 0.600 | 0.600 | 0.600 | 0.600 | 0.00 | — | 0 | 0 | 0 | 0 | 0 | 5 (0) | 0.71 / 0.88 | 467 / 561 / 561 |
| historical | 2 | 1.000 | 1.000 | 1.000 | 1.000 | 0.00 | — | 0 | 0 | 0 | 0 | 0 | 2 (0) | 0.77 / 1.07 | 920 / 1006 / 1006 |
| lifecycle | 4 | 1.000 | 1.000 | 1.000 | 1.000 | 0.00 | — | 0 | 0 | 0 | 0 | 0 | 4 (0) | 0.64 / 0.88 | 480 / 485 / 485 |
| distractor | 5 | 1.000 | 1.000 | 0.700 | 0.779 | 1.00 | — | 0 | 0 | 0 | 0 | 0 | 5 (0) | 0.61 / 0.77 | 897 / 982 / 982 |
| cross-namespace | 4 | 1.000 | 1.000 | 1.000 | 1.000 | 0.00 | — | 0 | 0 | 0 | 0 | 0 | 3 (0) | 0.76 / 1.16 | 481 / 561 / 561 |
| sparse-filter | 1 | 1.000 | 1.000 | 1.000 | 1.000 | 0.00 | — | 0 | 0 | 0 | 0 | 0 | 4 (3) | 0.67 / 3.19 | 282 / 921 / 921 |
| large-content | 1 | 1.000 | 1.000 | 1.000 | 1.000 | 0.00 | — | 0 | 0 | 0 | 0 | 0 | 1 (0) | 2.00 / 3.76 | 189320 / 189320 / 189320 |
| no-answer | 4 | 0.000 | 0.000 | 0.000 | 0.000 | 0.00 | 0.000 | 0 | 0 | 0 | 0 | 0 | 4 (0) | 0.53 / 1.15 | 56 / 56 / 56 |
| duplicate | 2 | 1.000 | 1.000 | 1.000 | 1.000 | 0.00 | — | 0 | 0 | 0 | 1 | 0 | 2 (0) | 0.83 / 2.67 | 820 / 821 / 821 |
| error | 3 | 0.000 | 0.000 | 0.000 | 0.000 | 0.00 | — | 0 | 0 | 0 | 0 | 0 | 0 (0) | 0.00 / 0.00 | 0 / 0 / 0 |

| Cost | Value |
| --- | --- |
| memories written | 72 |
| create p50 / p95 (ms) | 1.50 / 2.36 |
| lifecycle step p50 / p95 (ms) | 2.97 / 7.87 |
| build and check (s) | 0.2 |
| database with WAL | 0.8 MiB |
| cold start p50 / p95 (ms) | 9.20 / 19.87 |
| response bytes p95 | 982 B (~246 tokens) |
| response bytes max | 189,320 B (~47,330 tokens) |

## 10,000 filler notes

| Category | Queries | Recall@5 | Recall@10 | MRR | nDCG@10 | Non-relevant in top 10 | No-answer returned | Obsolete | Exposure | Errors | Duplicates | Fetches needed | Pages (partial) | Latency p50 / p95 (ms) | Bytes per response p50 / p95 / max |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| overall | 42 | 0.618 | 0.618 | 0.588 | 0.596 | 1.29 | 0.000 | 0 | 0 | 0 | 1 | 0 | 41 (3) | 0.60 / 14.51 | 472 / 5265 / 189320 |
| exact | 4 | 1.000 | 1.000 | 1.000 | 1.000 | 0.00 | — | 0 | 0 | 0 | 0 | 0 | 4 (0) | 0.47 / 1.21 | 472 / 500 / 500 |
| paraphrase | 7 | 0.000 | 0.000 | 0.000 | 0.000 | 0.00 | — | 0 | 0 | 0 | 0 | 0 | 7 (0) | 0.41 / 2.26 | 56 / 56 / 56 |
| correction | 5 | 0.400 | 0.400 | 0.400 | 0.400 | 2.00 | — | 0 | 0 | 0 | 0 | 0 | 5 (0) | 0.86 / 15.22 | 467 / 5235 / 5235 |
| historical | 2 | 0.500 | 0.500 | 0.500 | 0.500 | 5.00 | — | 0 | 0 | 0 | 0 | 0 | 2 (0) | 1.54 / 13.46 | 920 / 5235 / 5235 |
| lifecycle | 4 | 1.000 | 1.000 | 1.000 | 1.000 | 0.00 | — | 0 | 0 | 0 | 0 | 0 | 4 (0) | 0.82 / 1.51 | 480 / 485 / 485 |
| distractor | 5 | 0.800 | 0.800 | 0.600 | 0.652 | 2.80 | — | 0 | 0 | 0 | 0 | 0 | 5 (0) | 0.92 / 18.00 | 897 / 5295 / 5295 |
| cross-namespace | 4 | 0.667 | 0.667 | 0.667 | 0.667 | 3.33 | — | 0 | 0 | 0 | 0 | 0 | 3 (0) | 1.08 / 19.26 | 481 / 5265 / 5265 |
| sparse-filter | 1 | 1.000 | 1.000 | 1.000 | 1.000 | 0.00 | — | 0 | 0 | 0 | 0 | 0 | 4 (3) | 0.28 / 0.48 | 282 / 921 / 921 |
| large-content | 1 | 1.000 | 1.000 | 1.000 | 1.000 | 0.00 | — | 0 | 0 | 0 | 0 | 0 | 1 (0) | 1.67 / 2.79 | 189320 / 189320 / 189320 |
| no-answer | 4 | 0.000 | 0.000 | 0.000 | 0.000 | 0.00 | 0.000 | 0 | 0 | 0 | 0 | 0 | 4 (0) | 0.34 / 0.45 | 56 / 56 / 56 |
| duplicate | 2 | 1.000 | 1.000 | 1.000 | 1.000 | 0.00 | — | 0 | 0 | 0 | 1 | 0 | 2 (0) | 0.93 / 1.24 | 820 / 821 / 821 |
| error | 3 | 0.000 | 0.000 | 0.000 | 0.000 | 0.00 | — | 0 | 0 | 0 | 0 | 0 | 0 (0) | 0.00 / 0.00 | 0 / 0 / 0 |

| Cost | Value |
| --- | --- |
| memories written | 10,072 |
| create p50 / p95 (ms) | 5.60 / 12.14 |
| lifecycle step p50 / p95 (ms) | 10.26 / 17.89 |
| build and check (s) | 69.1 |
| database with WAL | 15.8 MiB |
| cold start p50 / p95 (ms) | 35.86 / 49.26 |
| response bytes p95 | 5,265 B (~1,317 tokens) |
| response bytes max | 189,320 B (~47,330 tokens) |

## Queries at 0 filler notes

| Query | Category | Outcome | First relevant rank | Recall@10 | Returned (top 5) |
| --- | --- | --- | --- | --- | --- |
| exact-error-code | exact | ok | 1 | 1.000 | error-e4012 |
| exact-ticket | exact | ok | 1 | 1.000 | ticket-alp-1182 |
| exact-person | exact | ok | 1 | 1.000 | owner-billing |
| exact-cluster | exact | ok | 1 | 1.000 | staging-current |
| para-token-lifetime | paraphrase | ok | — | 0.000 | — |
| para-price-cache | paraphrase | ok | — | 0.000 | — |
| para-billing-owner | paraphrase | ok | — | 0.000 | — |
| para-snapshots | paraphrase | ok | — | 0.000 | — |
| para-rotation-day | paraphrase | ok | — | 0.000 | — |
| para-toggles | paraphrase | ok | — | 0.000 | — |
| para-log-shape | paraphrase | ok | — | 0.000 | — |
| correct-release-new | correction | ok | 1 | 1.000 | release-day |
| correct-release-stale | correction | ok | — | 0.000 | — |
| correct-session-store | correction | ok | 1 | 1.000 | db-engine-v2 |
| correct-postgres | correction | ok | 1 | 1.000 | db-engine-v2 |
| correct-rabbitmq | correction | ok | — | 0.000 | — |
| history-session-store | historical | ok | 1 | 1.000 | db-engine-v1, db-engine-v2 |
| history-queue | historical | ok | 1 | 1.000 | queue-v1, queue-v2 |
| state-failover-default | lifecycle | ok | 1 | 1.000 | failover-current |
| state-failover-archived | lifecycle | ok | 1 | 1.000 | failover-old |
| state-staging-default | lifecycle | ok | 1 | 1.000 | staging-current |
| state-staging-tombstoned | lifecycle | ok | 1 | 1.000 | staging-old |
| noise-tokens | distractor | ok | 2 | 1.000 | noise-token-ui, api-token-ttl |
| noise-release | distractor | ok | 1 | 1.000 | release-day, noise-release-notes |
| noise-backup | distractor | ok | 1 | 1.000 | backup-schedule, noise-backup-ui |
| noise-stale-cache | distractor | ok | 2 | 1.000 | noise-browser-cache, price-cache |
| noise-session | distractor | ok | 2 | 1.000 | noise-session-ui, db-engine-v2 |
| scope-tokens | cross-namespace | ok | 1 | 1.000 | api-token-ttl |
| scope-session | cross-namespace | ok | 1 | 1.000 | db-engine-v2 |
| scope-queue-history | cross-namespace | ok | 1 | 1.000 | queue-v1 |
| scope-named-foreign | cross-namespace | expected-error (Forbidden) | — | — | — |
| sparse-sev1 | sparse-filter | ok | 1 | 1.000 | ops-sev1-dns, ops-sev1-disk |
| large-architecture | large-content | ok | 1 | 1.000 | arch-overview, arch-summary |
| none-autoscaling | no-answer | ok | — | — | — |
| none-budget | no-answer | ok | — | — | — |
| none-queue-current | no-answer | ok | — | — | — |
| none-scattered-words | no-answer | ok | — | — | — |
| dup-timeout | duplicate | ok | 1 | 1.000 | timeout-a, timeout-b |
| contra-audit | duplicate | ok | 1 | 1.000 | audit-90, audit-365 |
| reject-no-terms | error | expected-error (ValidationFailed) | — | — | — |
| reject-limit | error | expected-error (LimitExceeded) | — | — | — |
| reject-state | error | expected-error (ValidationFailed) | — | — | — |

## Known gaps

- Search has no stemming or synonyms, so paraphrases that share no word with the memory are not found.
- An earlier revision of a memory updated in place is reachable through `revision()`, not search; historical queries cover superseded memories only.
- The large-content query returns one memory larger than the 32 KiB response target; the target is judged at p95, and the max is shown beside it.
- Sparse metadata filters are measured as pages and partial pages at a scan budget of 10; storage does not report rows scanned.
