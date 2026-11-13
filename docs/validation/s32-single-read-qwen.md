# S32 — One read that selects and verifies (Qwen only)

Synthetic evidence; qualifies nothing. Generated 2026-11-13T14:55:19.349Z by `scripts/verify-recall-quality.ts` with `examples/ollama-provider.mjs --single-read`. Codex was not measured (S30).

## Setup

Ollama 0.40.16, `qwen2.5:7b` resident (one warm call first), 21 GPU layers, 4 threads, 4,096 context, 384 generated tokens, 12 passages of 384 characters within 16,384 bytes, 120 s deadline, expansion kept, no verify call, SQLite, 1,000 newer fillers, task queries, uncached, no retries. 116 provider calls.

## Result

- Passed: 49 of 58 (gate: at least 52). **Fail.**
- Unsupported context: none. The adversarial no-answer case returned nothing.
- Failing cases: exact-person, para-price-cache, para-billing-owner, correct-postgres, correct-rabbitmq, large-architecture, dup-timeout, held-para-invoice-backlog, old-paraphrase. All are empty or partial selections, not errors.
- End-to-end cold: p50 9248 ms, p95 13186 ms against 10,000 ms. **Fail.**

| Phase  | Calls | p50 ms | p95 ms |
| ------ | ----: | -----: | -----: |
| expand |    58 |   2321 |   3968 |
| select |    58 |   6850 |  10122 |

## Limits

One run on one host (16 CPUs, 32 GiB, T1200 4 GiB GPU), weights resident; S30 measured the unloaded p95 at 12.4 s for a single call. The shipped-verifier comparison (52/58, 14.3 s / 29.2 s) is from 2026-11-05 on the same host class, not re-run here. The prompt was not tuned after the run.

Raw rows: [s32-single-read-qwen.json](s32-single-read-qwen.json).
