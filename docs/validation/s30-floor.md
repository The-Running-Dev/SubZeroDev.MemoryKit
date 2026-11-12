# S30: floor of one provider call

Measured 2026-11-12 with `scripts/measure-provider-floor.ts`. Evidence is synthetic: one
passage, one question, limit 3, a `select` request through the real adapters. Nothing in a prompt,
model or gate changed. Raw samples, failures included, are in `s30-floor-codex.json` and
`s30-floor-qwen.json`.

## Host

Windows 11, 16 CPUs, 32 GiB, Node 24, NVIDIA T1200 Laptop GPU (4 GiB). Codex CLI 0.158.0
(ChatGPT login). Ollama 0.40.16 with `qwen2.5:7b` (ID `845dbda0ea48`, the S26 model), loaded about
59% CPU / 41% GPU, 16,384 context. The Codex run began with 2.3 GiB of GPU memory already held by
a resident Ollama model and no GPU use; the Qwen run began with the GPU empty.

## Provider identity

`gpt-6.1-sol`, the model S26 qualified, is rejected for this ChatGPT account ("not supported when
using Codex with a ChatGPT account"), including with the owner's own Codex configuration. The
Codex arms therefore measure `gpt-6-sol`, a different provider identity. A trivial probe of the
other catalog models succeeded for `gpt-6-sol`, `gpt-6-astra`, `gpt-6-luna` and `gpt-5.6-sol`,
`-terra`, `-luna`, and failed for `gpt-6.1-terra`; those were single calls, not samples.

## Results (30 samples each, milliseconds, nearest-rank)

| Provider and profile              | Failed | Timed out |    p50 |    p95 |    Max |
| --------------------------------- | -----: | --------: | -----: | -----: | -----: |
| Codex `gpt-6-sol`, seeded catalog |      0 |         0 |  5,183 | 11,038 | 12,719 |
| Codex `gpt-6-sol`, fresh catalog  |      1 |         0 |  5,427 | 10,114 | 10,163 |
| Qwen 2.5 7B, weights unloaded     |      0 |         0 | 10,436 | 12,445 | 13,750 |
| Qwen 2.5 7B, weights resident     |      0 |         0 |    862 |    884 |    907 |

Wall time includes the adapter process and CLI start. Codex lifecycle `turnMs` p50/p95 was
3,742/9,701 ms seeded and 4,288/8,557 ms fresh. The one failed Codex sample (fresh arm) is kept
and counted; it failed after 3,203 ms. The failed sample is included in the percentiles above.
Resident Qwen was loaded by one uncounted call (721 ms) before its samples.

## Limits

- A single window on one host and account. An earlier two-sample smoke run on the same model
  took 3.9 s to 5.5 s, so Codex latency varies by time; one window does not bound it.
- The request is far smaller than a real recall (one passage against the 58 cases with 1,000
  fillers), so these are floors. Real calls cost at least this much.
- Not a quality or readiness qualification. The 10,000 ms cold p95 limit is unchanged.
