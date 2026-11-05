# Cold latency investigation, 2026-11-05

Base: `1d0903efb59a3cdd4d79dca4824d9d5e3a2ec85c` (PR #48). This is an investigation and
compatible adapter change, not a new successful real-model qualification.

## Recorded Windows evidence

The unchanged [58-case Codex report](semantic-codex-final.json) contains 58 expansion calls,
58 selections and 49 independent verifications: 165 completed calls, no retries. Nearest-rank
cold p95 is 37,781.58 ms. The p95 case is `held-correct-release-afternoon`:

| Cost | At the end-to-end p95 case | Share across all 58 cases |
| --- | ---: | ---: |
| Expansion, including its subprocesses | 15,311.52 ms | 39.46% |
| Selection, including its subprocesses | 11,692.05 ms | 32.45% |
| Independent verification, including its subprocesses | 10,725.60 ms | 27.82% |
| Everything outside provider calls | 52.41 ms | 0.27% |

The non-provider residual has p50 45.31 ms and p95 144.43 ms; it includes retrieval, validation
and workflow bookkeeping. It is not a storage-only timer. Phase p95s must not be summed.
Expansion is the largest aggregate phase, but no phase uniquely explains the tail. Even
discarding all non-provider work cannot materially close the 27.8-second readiness gap.

The shipped [Qwen report](semantic-qwen-qualified.json) similarly spends 99.57% inside provider
phases. Its 29,230.23 ms p95 case spends 5,691.53 ms expanding, 7,747.87 ms selecting and
15,747.46 ms verifying, with an additional 43.37 ms outside those calls. Across all cases,
expansion/selection/verification account for 24.78%/37.11%/37.68% respectively. The six quality
failures remain. Removing quoted evidence is not a performance fix.

**Inference:** provider initialization and execution are the credible optimization surface.
The original records cannot distinguish network/catalog setup, native startup, model loading
or inference. They do not justify blaming process creation or changing any semantic stage.

## Change and local measurements

The Codex adapter now seeds only the existing native model catalog into its temporary home.
Codex still validates its freshness/version/provider identity. This removes an avoidable cache
miss when that metadata is valid; it does not cache queries, evidence or provider selections.
The [decision](../decisions/0011-codex-catalog-and-provider-timing.md) records boundaries and
upstream implementation evidence. `catalogCopied` does not establish `catalogHit`.

Both adapters accept `--timings /absolute/private/file.jsonl`. Existing protocol output stays
unchanged. Codex measures spawn, first event, thread start, turn start/completion, process exit
and total adapter duration. `turnMs` includes transport, scheduling and provider work; time to
turn start can include native initialization/auth/catalog discovery. Adapter timing starts after
Node has started; compare it with the harness phase elapsed time to see outer Node/transport
overhead. Event delivery is only an approximation of internal boundaries.

Ollama records client HTTP duration plus server `totalMs`, `loadMs`, `prompt_evalMs` and
`evalMs` when supplied. Server total includes more than inference and durations need not sum
exactly. No fabricated durations are supplied when fields are absent. No query, prompt,
credential, raw event, model answer or server diagnostic is written to these files.

Linux x64, Node 24.22.1, Codex 0.167.0-alpha.4, 30 samples per local transport group
([raw transport samples](cold-latency-linux-transport.json),
[recorded phase analysis](cold-latency-codex-analysis.json)):

| Controlled operation | p50 | p95 |
| --- | ---: | ---: |
| Fresh Node command, stdin JSON and empty synthetic response | 74.06 ms | 87.53 ms |
| In-process resolved Promise with the same empty response | 0.00039 ms | 0.00594 ms |
| Native `codex --version` process only | 12.01 ms | 17.76 ms |

These use warm OS filesystem caches. The first group measures command transport/process cost,
not Codex initialization, retrieval or a model. The version probe does not initialize a model
session. These are not Windows measurements, and they are not an end-to-end before/after gain.

Real Linux expansion probes failed: fresh catalog and seeded catalog each hit the diagnostic
15-second timeout before the first lifecycle event; a seeded probe using the host-configured
backend also reached its 20-second timeout. No successful provider execution was measured.
The initial unmodified adapter probe also timed out at 15 seconds. The new adapter's
[diagnostic probe records](cold-latency-linux-probes.json) retain its failures. Diagnostic timeouts do not
replace the qualification configuration. No successful speedup, new 58/58 result, model-turn
duration or native cache hit is claimed. The original NVIDIA T1200/Windows host, Ollama service,
Claude Code host and live PostgreSQL service are unavailable here.

## Reproduce and qualify on Windows

Use the native Codex executable, the same model/account, SQLite, 1,000 newer fillers, zero
retries and the original 58-case task suite. Record executable version and machine/load/GPU
state. Close competing workloads. Keep model residency fixed and report it; "cold" below
means no MemoryKit provider-result cache, not guaranteed empty OS caches or unloaded weights.

Create fresh/seeded selector files with PowerShell 7 from the checkout. Keep evidence outside
the checkout. Each file uses a unique identity/fingerprint; old evidence cannot attest this
changed adapter. Use a recent catalog produced by the **same installed native CLI/account**.
Do not edit timestamps or copy metadata from another version/account.
An expired or incompatible source catalog provides no acceleration; record that condition
and retain those attempts. This change does not persist renewed catalogs between calls.

```powershell
$repo = (Get-Location).Path
$out = Join-Path $env:TEMP 'memorykit-cold-comparison'
New-Item -ItemType Directory -Force $out | Out-Null
$node = (Get-Command node).Source
$codex = 'C:\absolute\path\to\codex.exe'
& $codex --version
foreach ($arm in @('fresh', 'seeded')) {
  $adapterArgs = @((Join-Path $repo 'examples/codex-recall.mjs'),
    '--codex', $codex, '--model', 'gpt-6.1-sol', '--timeout-ms', '90000')
  if ($arm -eq 'fresh') { $adapterArgs += '--fresh-model-catalog' }
  @{
    id = "codex-gpt-6.1-sol-catalog-$arm"
    command = @{ command = $node; args = $adapterArgs; timeoutMs = 110000 }
    discovery = $true; verification = $true; retries = 0; deadlineMs = 60000
    budget = @{ passages = 16; passageChars = 1024; bytes = 24576 }
  } | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8 (Join-Path $out "$arm.json")
}
# ABBA order reduces order effects; retain every result, including failures.
# The default harness has all 58 eligible cases and 10 excluded raw-search scenarios.
$index = 0
foreach ($arm in @('fresh', 'seeded', 'seeded', 'fresh')) {
  $index++
  $config = Get-Content -Raw (Join-Path $out "$arm.json") | ConvertFrom-Json
  $config.command.args += @('--timings', (Join-Path $out "$index-$arm-timing.jsonl"))
  $selector = Join-Path $out "$index-$arm-selector.json"
  $config | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8 $selector
  node scripts/verify-recall-quality.ts --selector $selector --storage sqlite --filler 1000 --tasks --assert --report (Join-Path $out "$index-$arm.json")
  # --assert checks quality. Inspect cold p95 independently against 10000 ms.
  node scripts/analyze-recall-latency.ts --report (Join-Path $out "$index-$arm.json") --timings (Join-Path $out "$index-$arm-timing.jsonl") --output (Join-Path $out "$index-$arm-analysis.json")
}
# Separate warm experiment: immediate repeated-query result cache, never the cold gate.
node scripts/verify-recall-quality.ts --selector (Join-Path $out 'seeded.json') --storage sqlite --filler 1000 --tasks --cache --assert --report (Join-Path $out 'warm.json')
node scripts/measure-command-overhead.ts --codex $codex --samples 30 --report (Join-Path $out 'transport.json')
```

For a strictly unmodified S26 adapter baseline, run this additional arm without the new
timing flags. Compare it with the current `fresh` arm to isolate timing/async-process overhead
from catalog seeding. Do not use a resumed conversation or remove independent verification.

```powershell
$baseline = Join-Path $out 'baseline'
New-Item -ItemType Directory -Force $baseline | Out-Null
foreach ($name in @('codex-recall.mjs', 'compact-recall.mjs', 'recall-prompt.mjs')) {
  git show "1d0903efb59a3cdd4d79dca4824d9d5e3a2ec85c:examples/$name" |
    Set-Content -Encoding utf8 (Join-Path $baseline $name)
}
$config = Get-Content -Raw (Join-Path $out 'fresh.json') | ConvertFrom-Json
$config.id = 'codex-gpt-6.1-sol-unmodified-s26'
$config.command.args = @((Join-Path $baseline 'codex-recall.mjs'),
  '--codex', $codex, '--model', 'gpt-6.1-sol', '--timeout-ms', '90000')
$config | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8 (Join-Path $out 'baseline.json')
node scripts/verify-recall-quality.ts --selector (Join-Path $out 'baseline.json') --storage sqlite --filler 1000 --tasks --assert --report (Join-Path $out 'baseline-result.json')
```

For Qwen, add `--timings /absolute/qwen-timing.jsonl` to the existing shipped selector args
and rerun the full harness with `--tasks --filler 1000 --assert`. Preserve model ID
`845dbda0ea48`, 21 GPU layers, four CPU threads, 4,096 context tokens, 128 generated tokens,
12 passages × 384 characters, 16,384 bytes and the 120-second total deadline on the original
GPU. Run the immediate cache experiment separately with `--cache`. Explicitly record a
weights-unloaded run versus a resident-weights run; do not label residency effects as Node
startup. The shipped adapter defaults differ from this qualification profile.

## Validation and readiness

The local serial suite passed **416 tests, three skipped, zero failed**. All three skips
require live PostgreSQL. Typecheck, lint, installed-package/CLI/consumer/hooks/storage-plugin/
Git-history checks and non-publishing release guards passed. The lexical evaluation at zero
fillers completed with zero exposure, obsolete-result or unexpected-error violations; its
existing paraphrase/overall relevance targets remain unmet. That lexical evaluation is not
the model-based 58-case acceptance suite.

The new regression check was also run with
catalog seeding disabled and failed because the isolated catalog was absent; with the change
restored it passes. Tests cover optional-cache fallback, isolated files, unchanged extractive
selection/verification, late error/tool/malformed events, output bounds, timeout/start failure
and numeric-only Ollama timing on success/failure.

The original 58-case suite, evidence requirements and **10,000 ms cold p95** gate are unchanged.
The updated adapter still needs complete uncached real-provider quality and timing runs,
configuration/package-bound native Codex and Claude checks, and migration/rollback validation
on the actual candidate. Qwen additionally needs all six retrieval failures resolved without
unsupported context. Missing native/GPU evidence is not a pass. Even successful synthetic
qualification does not authorize daily replacement, personal ingestion, npm publication or
merge; none was performed.
