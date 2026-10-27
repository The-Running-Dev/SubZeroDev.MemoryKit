# Retrieval evaluation

Commit `780f2689196be9e56395ef1745eefa9c4e5c101d`. Node v26.12.1 on win32 x64, 11th Gen Intel(R) Core(TM) i7-11850H @ 2.50GHz. Each query ran 5 time(s); the first run is scored.

Bytes are the UTF-8 length of each search result as JSON. Tokens are estimated as ceil(bytes / 4), not counted by a tokenizer. Latency is per search call, in process. Cold start is open plus one search, in process, on a closed store.

## Thresholds

Recorded in `design/90-decisions.md` (2026-10-27) before the first run. Hard thresholds gate CI; targets are reported, not gated.

| Threshold | Kind | Judged at filler | Limit | Measured | Met |
| --- | --- | --- | --- | --- | --- |
| unauthorized exposure | hard | 0 | = 0 | 0 | yes |
| obsolete results in current answers | hard | 0 | = 0 | 0 | yes |
| unexpected, wrong or missing errors | hard | 0 | = 0 | 0 | yes |
| exact-identifier recall@5 | target | 0 | = 1.0 | 1 | yes |
| overall recall@10 | target | 0 | ≥ 0.90 | 0.647 | **no** |
| paraphrase recall@10 | target | 0 | ≥ 0.70 | 0 | **no** |
| overall MRR | target | 0 | ≥ 0.75 | 0.618 | **no** |
| mean non-relevant items in top 10 | target | 0 | ≤ 2 | 0.147 | yes |
| no-answer queries returning anything | target | 0 | ≤ 20% | 0 | yes |
| search p95 (ms) | target | 10,000 | ≤ 50 | 19.812 | yes |
| response bytes p95 | target | 10,000 | ≤ 32 KiB | 10413 | yes |
| cold start p95 (ms) | target | 10,000 | ≤ 500 | 47.416 | yes |

## 0 filler notes

| Category | Queries | Recall@5 | Recall@10 | MRR | nDCG@10 | Non-relevant in top 10 | No-answer returned | Obsolete | Exposure | Errors | Duplicates | Fetches needed | Pages (partial) | Latency p50 / p95 (ms) | Bytes p50 / p95 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| overall | 41 | 0.647 | 0.647 | 0.618 | 0.625 | 0.15 | 0.000 | 0 | 0 | 0 | 1 | 0 | 40 (3) | 0.55 / 1.25 | 476 / 1767 |
| exact | 4 | 1.000 | 1.000 | 1.000 | 1.000 | 0.00 | — | 0 | 0 | 0 | 0 | 0 | 4 (0) | 0.58 / 1.25 | 472 / 500 |
| paraphrase | 7 | 0.000 | 0.000 | 0.000 | 0.000 | 0.00 | — | 0 | 0 | 0 | 0 | 0 | 7 (0) | 0.45 / 0.62 | 56 / 56 |
| correction | 5 | 0.600 | 0.600 | 0.600 | 0.600 | 0.00 | — | 0 | 0 | 0 | 0 | 0 | 5 (0) | 0.64 / 0.71 | 467 / 561 |
| historical | 2 | 1.000 | 1.000 | 1.000 | 1.000 | 0.00 | — | 0 | 0 | 0 | 0 | 0 | 2 (0) | 0.78 / 1.44 | 920 / 1006 |
| lifecycle | 4 | 1.000 | 1.000 | 1.000 | 1.000 | 0.00 | — | 0 | 0 | 0 | 0 | 0 | 4 (0) | 0.57 / 0.71 | 480 / 485 |
| distractor | 5 | 0.400 | 0.400 | 0.200 | 0.252 | 1.00 | — | 0 | 0 | 0 | 0 | 0 | 5 (0) | 0.58 / 0.70 | 478 / 982 |
| cross-namespace | 4 | 1.000 | 1.000 | 1.000 | 1.000 | 0.00 | — | 0 | 0 | 0 | 0 | 0 | 3 (0) | 0.60 / 3.94 | 481 / 561 |
| sparse-filter | 1 | 1.000 | 1.000 | 1.000 | 1.000 | 0.00 | — | 0 | 0 | 0 | 0 | 0 | 4 (3) | 0.31 / 0.77 | 1767 / 1767 |
| large-content | 1 | 1.000 | 1.000 | 1.000 | 1.000 | 0.00 | — | 0 | 0 | 0 | 0 | 0 | 1 (0) | 2.11 / 2.42 | 189320 / 189320 |
| no-answer | 3 | 0.000 | 0.000 | 0.000 | 0.000 | 0.00 | 0.000 | 0 | 0 | 0 | 0 | 0 | 3 (0) | 0.36 / 0.47 | 56 / 56 |
| duplicate | 2 | 1.000 | 1.000 | 1.000 | 1.000 | 0.00 | — | 0 | 0 | 0 | 1 | 0 | 2 (0) | 0.57 / 0.77 | 820 / 821 |
| error | 3 | 0.000 | 0.000 | 0.000 | 0.000 | 0.00 | — | 0 | 0 | 0 | 0 | 0 | 0 (0) | 0.13 / 0.21 | 0 / 0 |

| Cost | Value |
| --- | --- |
| memories written | 72 |
| create p50 / p95 (ms) | 3.65 / 6.17 |
| lifecycle step p50 / p95 (ms) | 5.75 / 13.59 |
| build and check (s) | 0.4 |
| database with WAL | 0.8 MiB |
| cold start p50 / p95 (ms) | 9.44 / 14.28 |
| response bytes p95 | 1,767 B (~442 tokens) |

## 10,000 filler notes

| Category | Queries | Recall@5 | Recall@10 | MRR | nDCG@10 | Non-relevant in top 10 | No-answer returned | Obsolete | Exposure | Errors | Duplicates | Fetches needed | Pages (partial) | Latency p50 / p95 (ms) | Bytes p50 / p95 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| overall | 41 | 0.529 | 0.529 | 0.515 | 0.519 | 1.82 | 0.000 | 0 | 0 | 0 | 1 | 0 | 40 (3) | 0.60 / 19.81 | 480 / 10413 |
| exact | 4 | 1.000 | 1.000 | 1.000 | 1.000 | 0.00 | — | 0 | 0 | 0 | 0 | 0 | 4 (0) | 0.53 / 1.20 | 472 / 500 |
| paraphrase | 7 | 0.000 | 0.000 | 0.000 | 0.000 | 0.00 | — | 0 | 0 | 0 | 0 | 0 | 7 (0) | 0.46 / 0.87 | 56 / 56 |
| correction | 5 | 0.400 | 0.400 | 0.400 | 0.400 | 2.00 | — | 0 | 0 | 0 | 0 | 0 | 5 (0) | 1.09 / 14.12 | 467 / 10273 |
| historical | 2 | 0.500 | 0.500 | 0.500 | 0.500 | 5.00 | — | 0 | 0 | 0 | 0 | 0 | 2 (0) | 1.06 / 13.76 | 920 / 10273 |
| lifecycle | 4 | 1.000 | 1.000 | 1.000 | 1.000 | 0.00 | — | 0 | 0 | 0 | 0 | 0 | 4 (0) | 0.55 / 0.91 | 480 / 485 |
| distractor | 5 | 0.200 | 0.200 | 0.100 | 0.126 | 6.40 | — | 0 | 0 | 0 | 0 | 0 | 5 (0) | 17.85 / 23.91 | 10255 / 10413 |
| cross-namespace | 4 | 0.667 | 0.667 | 0.667 | 0.667 | 3.33 | — | 0 | 0 | 0 | 0 | 0 | 3 (0) | 1.17 / 29.25 | 481 / 10288 |
| sparse-filter | 1 | 1.000 | 1.000 | 1.000 | 1.000 | 0.00 | — | 0 | 0 | 0 | 0 | 0 | 4 (3) | 0.30 / 0.50 | 1767 / 1767 |
| large-content | 1 | 1.000 | 1.000 | 1.000 | 1.000 | 0.00 | — | 0 | 0 | 0 | 0 | 0 | 1 (0) | 1.70 / 2.28 | 189320 / 189320 |
| no-answer | 3 | 0.000 | 0.000 | 0.000 | 0.000 | 0.00 | 0.000 | 0 | 0 | 0 | 0 | 0 | 3 (0) | 0.44 / 0.63 | 56 / 56 |
| duplicate | 2 | 1.000 | 1.000 | 1.000 | 1.000 | 0.00 | — | 0 | 0 | 0 | 1 | 0 | 2 (0) | 0.96 / 1.24 | 820 / 821 |
| error | 3 | 0.000 | 0.000 | 0.000 | 0.000 | 0.00 | — | 0 | 0 | 0 | 0 | 0 | 0 (0) | 0.06 / 0.09 | 0 / 0 |

| Cost | Value |
| --- | --- |
| memories written | 10,072 |
| create p50 / p95 (ms) | 5.91 / 10.67 |
| lifecycle step p50 / p95 (ms) | 10.97 / 14.79 |
| build and check (s) | 66.2 |
| database with WAL | 15.8 MiB |
| cold start p50 / p95 (ms) | 39.60 / 47.42 |
| response bytes p95 | 10,413 B (~2,604 tokens) |

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
| noise-release | distractor | ok | — | 0.000 | noise-release-notes |
| noise-backup | distractor | ok | — | 0.000 | noise-backup-ui |
| noise-stale-cache | distractor | ok | — | 0.000 | noise-browser-cache |
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
| dup-timeout | duplicate | ok | 1 | 1.000 | timeout-a, timeout-b |
| contra-audit | duplicate | ok | 1 | 1.000 | audit-90, audit-365 |
| reject-no-terms | error | expected-error (ValidationFailed) | — | — | — |
| reject-limit | error | expected-error (LimitExceeded) | — | — | — |
| reject-state | error | expected-error (ValidationFailed) | — | — | — |

## Known gaps

- Search has no stemming or synonyms, so paraphrases that share no word with the memory are not found.
- An earlier revision of a memory updated in place is reachable through `revision()`, not search; historical queries cover superseded memories only.
- Sparse metadata filters are measured as pages and partial pages at a scan budget of 10; storage does not report rows scanned.
