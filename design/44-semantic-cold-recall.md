# S26 — Independent retrieval and cold qualification

Owner-authorized continuation after S25, 2026-11-03.

Fix query expansion that repeats broad category words and surrounding chores instead of
discovering concrete evidence. Reduce model prompt and runtime overhead without removing
selection, verification, abstention, exact quotes, current revision checks or scope isolation.
Keep storage discovery provider-neutral and bounded.

Measure expansion, selection and verification separately, including failed phases. Compare
full uncached task qualification against S25 using all 58 eligible cases and 1,000 newer
fillers. Use the current installed Codex executable and independently run Qwen. Focused
diagnostics guide changes but never substitute for the full gate. Retain the ten-second
cold p95 readiness limit and report remaining failures.

Run deterministic checks, live PostgreSQL conformance, installed-package and release checks,
and native host/migration rehearsals affected by the provider change. Bind packaged evidence
to a clean source commit. Open the next PR; no merge, publication, personal ingestion or
global installation cutover is part of this work.
