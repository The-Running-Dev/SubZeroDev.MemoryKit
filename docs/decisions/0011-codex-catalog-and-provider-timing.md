# ADR-0011: Reuse native catalog metadata inside isolated Codex calls

Status: Implemented, pending native performance qualification, 2026-11-05.

The S26 evidence places almost all cold time inside provider phases, but does not separate
CLI initialization from model execution. Each Codex phase starts with a new home and loses
the native model catalog cache. Seed only `models_cache.json` alongside the existing auth
copy. Leave freshness, version and provider/account validation to Codex; never alter cache
timestamps or write it back. Missing, unreadable or oversized optional metadata falls back
to native discovery. Copying is not proof of a native cache hit. Models can still be fetched.

Codex's [cache implementation](https://github.com/openai/codex/blob/main/codex-rs/models-manager/src/cache.rs)
and [manager](https://github.com/openai/codex/blob/main/codex-rs/models-manager/src/manager.rs)
own validation. Its [version/TTL tests](https://github.com/openai/codex/blob/main/codex-rs/core/tests/suite/models_cache_ttl.rs)
and [identity tests](https://github.com/openai/codex/blob/main/codex-rs/core/tests/suite/models_cache_auth.rs)
describe invalidation. These upstream sources were inspected on 2026-11-05; the target native
executable must still be qualified. The old Windows build and this Linux build differ.

Keep fresh subprocesses, isolated instructions, independent verification, exact quote/revision
validation and fail-closed event handling. The model catalog is trusted native runtime metadata,
not recalled memory. No settings, rules, sessions, skills or retrieval results are imported.
`--fresh-model-catalog` retains the former no-catalog behavior for controlled comparison.

Optional adapter timing files contain only fixed numeric metrics, phase names and booleans.
Codex records lifecycle boundaries while continuing to validate the entire event stream and
exit status. Ollama records HTTP elapsed time and its native numeric duration fields. Neither
metric source proves pure model inference time. No public provider interface or wire response
changes. No new dependency or persistent worker is introduced.

Rejected: skipping verification or expansion, changing model prompts or effort, accepting
unsupported quotes, relaxing the 58-case gate or 10-second threshold, and sharing a long-lived
conversation between selection and verification. None is justified by the available timings.
Retrieval optimization has little measured headroom on the recorded SQLite workload. Persistent
workers and different provider transports need separate evidence and contract review.

See [measurement results and reproduction](../validation/cold-latency-investigation.md).
