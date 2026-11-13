# Cold recall latency: Stage 5 re-planned for S26

Plan only. It changes no code, no gate and no earlier decision.

## The problem, from the recorded runs

S26's full 58-case gate (SQLite, 1,000 newer fillers, uncached, zero retries) passes quality
with Codex (58/58) and fails the unchanged 10,000 ms cold p95 readiness limit:

| Run                            | Passed | Cold p50 | Cold p95 |
| ------------------------------ | -----: | -------: | -------: |
| Codex, final isolated selector |  58/58 |   21.5 s |   37.8 s |
| Qwen 2.5 7B, shipped verifier  |  52/58 |   14.3 s |   29.2 s |

99.6% of Codex time is inside three serial provider calls: expansion 39%, selection 32%,
independent verification 28%. Everything MemoryKit does itself (retrieval, validation,
bookkeeping) is p50 45 ms and p95 144 ms. No call-level tuning has closed this: removing
quoted evidence, prompt shortening, catalog seeding and GPU offload each moved it by seconds,
not by the 3x to 4x needed.

## What Stage 5 does and does not say

Stage 5 closed with S17's lexical `retrieve`, because embedding models and rerankers could not
empty no-answer questions (S18, S21). That finding concerned using a model score as the _final_
answer. S26 never does that: its verification phase is what abstains. The unasked question is
whether a model-free step can replace a _model call_ whose job is only to propose candidates.
S18 measured the ingredients: MiniLM vectors took heldout-2 recall@10 from 0.429 to 0.857,
with a 537 ms cold start and 5 ms queries. The closure stands for `retrieve`; this plan does
not reopen it.

## Three levers, and what each can buy

Costs below use the Codex p95 case (expansion 15.3 s, selection 11.7 s, verification 10.7 s).

1. **Drop the expansion call** and generate candidates with local retrieval (lexical, vector or
   fused), recall-first and with no floor. Saves up to about 15 s at p95. Risk: candidates miss
   a record that model-written aliases found.
2. **Fuse selection and verification** into one call that returns passage indices with exact
   quotes, checked by the same deterministic quote and revision validators. Saves up to about
   11 s. Risk: the independent second read is what kept unsupported context out (the Qwen
   index-only run admitted five unsupported queries, including the adversarial one).
3. **Take the model off the prompt path** where a task allows (for example a SessionStart
   prefetch keyed on the project, using S29's hook and lease pattern). Does not help a task
   whose question is unknown until the prompt.

Levers 1 and 2 together leave one provider call. If that call alone has a p95 above 10 s, no
arrangement of MemoryKit work reaches the gate with that provider, and the plan must say so
rather than loosen the gate.

## Slices

All are measurement before build, as in S18 and S21. Evidence is synthetic.

- **S30 Floor.** Measure one minimal-prompt call per provider and profile (Codex fresh and
  seeded catalog; Qwen with weights unloaded and resident), p50 and p95, on the original
  Windows host. Gate: a single call's p95 is at most 8 s. If it is not, stop: record that the
  provider cannot meet the limit and close the plan with that decision.
- **S31 Candidates without expansion.** On the 58 cases plus 1,000 fillers, compare each
  case's candidate set from the expansion call against S17 lexical, MiniLM vector and RRF at
  depths 16 and 24, with oracle selection. Gate: no needed record present under expansion is
  missing from the candidate set, and no case gains an irrelevant record into the verified
  answer.
- **S32 One read.** A single select-and-verify call over the S31 candidates, same validators.
  Gate: Qwen at least 52 (Codex dropped after S30) with no unsupported context and the adversarial case
  abstaining; stated p95 per phase.
- **S33 Build and qualify**, only for what S31 and S32 passed: optional provider-neutral
  candidate source (the embedder interfaces removed when Stage 5 closed return only as narrowly
  as S31 needs), the fused call, and the full S26 gate including native hosts, doctor readiness
  and migration/rollback. A new provider identity and a new full run are required.

## Stop rules and non-goals

- The 10 s limit is not raised, and verification, abstention, exact quotes, revision checks and
  scope isolation are not weakened to reach it.
- A focused diagnostic never substitutes for the full gate.
- If S30 fails, daily automatic recall stays opt-in and manual, and the decision is recorded.
- No model download in CI, no personal data, no publication, no cutover.
- S30 and the S33 qualification need the original Windows/GPU host and the owner's Codex login;
  they cannot run in CI.
