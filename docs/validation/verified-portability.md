# Verified recall, host lifecycle and storage portability

Validation date: 2026-11-01. All source material and host conversations used here are
synthetic. These results extend the [previous portable-storage report](portable-storage.md).

## Behavior covered

Recall profiles can enable discovery and a second verification pass. The verifier sees
only authorized proposed passages, can remove proposals or repair exact quotes, and cannot
add records. Final validation checks identity, revision, eligibility and contiguous evidence;
injection contains the selected evidence. The second pass can still make semantic mistakes.

Offline SDK/CLI archives preserve current records, review metadata, provenance, IDs,
revisions, namespace policies and retained Git history across SQLite, Markdown and PostgreSQL.
They exclude tokens and operation replay caches. Import requires a new destination, validates
the archive and Git bundle, and compares the restored snapshot before exposing its directory.
Stop writers, drain history and serialize administrators. Checksums establish integrity, not
producer authenticity. See [storage configuration and migration](../storage-plugins.md).

PostgreSQL is an optional module, loaded explicitly through the public package subpath or
the existing storage-plugin interface. It stores one JSONB snapshot per logical store,
serializes writes with row locks, and shares the deterministic Markdown state operations.
Git remains independent local retained history. This layout targets modest stores; search
is linear and multiple independent Git directories are not a distributed deployment.

## Credential-free checks

- Typecheck, lint, build, release guards and installed-package checks pass.
- The full local suite reports 374 tests in 49 suites: 373 pass, zero failures, one
  PostgreSQL integration test skipped without its opt-in connection variable. That test
  passes separately with PostgreSQL enabled.
- PostgreSQL shared conformance passes all 66 scenarios across SDK, CLI, HTTP, HTTPS/OIDC,
  MCP stdio and MCP HTTP. Its transaction tests cover independent writers, rollback,
  lock timeouts, reopen behavior and credential-free configuration diagnostics.
- The PostgreSQL-enabled migration suite passes 14 tests, including all nine backend pairs,
  exclusion of source tokens, continued history/revisions, supersession, tombstone restore,
  purge with retained Git history, malformed archives and CLI administration.
- Installed-package checks cover public-entry isolation for memory/none history, portable
  CLI commands, consumers, storage plugins, Git composition and supersede retry behavior.

CI repeats the full suite and package checks on Linux/Windows with Node 22.18/24 and runs
the PostgreSQL matrix against PostgreSQL 18 on Linux. Local PostgreSQL validation used an
isolated PostgreSQL 18 container.

## Native host acceptance

| Host / selector | Version | Result |
| --- | --- | --- |
| Claude Code / Claude Haiku | 2.1.302 | [14/14 passed](verified-native-claude.json) |
| Codex / existing-login default Codex model | 0.158.0 | [15/15 passed](verified-native-codex.json) |

Both use an installed package CLI, working-tree example selectors, SQLite storage and
upgraded generated configuration in isolated synthetic projects. Existing logins supply
model access. Global host configuration and personal project data are not changed.

Checks include fresh host processes, project isolation, explicitly shared scopes, no-answer
abstention, correction after restart, paraphrase and verbose tasks. The new lifecycle checks
capture a synthetic user statement through the actual native Stop hook, exclude it while
unaccepted, explicitly accept it with the CLI, recall it after restarting, supersede it,
and recall the correction. Each host then emits a real PreCompact event and recalls the
correction afterward. Codex also executes the generated command without the observation
wrapper. A zero byte count on that unwrapped check means output was not instrumented.

Capture is enabled only in the fixture. It remains off by default. Codex hook trust bypass
is restricted to the reviewed generated hooks in the isolated test home. These small native
fixtures establish host lifecycle behavior, not broad model quality or S18/S21 parity.

## Upstream claude-mem serializer

The [fixture provenance](../../tests/fixtures/claude-mem-upstream-export.md) identifies a
pinned upstream commit and Git blob. The generator fetches and verifies that source, then
executes its unmodified export function against synthetic worker responses. Tests import the
actual serializer output as candidates, preserve user versus generated attribution, explicitly
accept a user record, verify idempotent reimport, and migrate the result with provenance and
Git history intact. This does not exercise a live user's worker database or upstream search.

```sh
node --experimental-vm-modules scripts/verify-claude-mem-export.ts
```

## Retrieval quality protocol

The quality harness uses active, accepted, exact-scope workflow recall. Ten corpus scenarios
for raw search features are skipped explicitly. Task mode rewrites six ambiguous lexical
queries to state their requested relationship; source facts, relevance labels, lifecycle and
held-out queries stay unchanged. Raw mode remains available. All facts precede 1,000 newer
irrelevant notes. Deep evidence, old paraphrase/verbose tasks and adversarial abstention are
reported separately. Provider payload bytes are not token usage or monetary cost.

The earlier audited runs are retained: [Claude](verified-quality-claude-before.json) missed
six valid answers and [Codex](verified-quality-codex-before.json) missed one. Both had zero
false injections and provider errors, correctly abstained on eight no-answer questions and
passed all four scale/adversarial cases. Tracing showed supplied supporting passages were
sometimes rejected for ordinary synonyms or a question's incorrect premise. Shared selection
and verification instructions now preserve supported partial and corrective answers.

The [final Claude run](verified-quality-claude.json) passes every measured case: 28/28
answerable corpus queries, 18/18 answerable held-out queries, 8/8 no-answer abstentions and
4/4 scale/adversarial cases, with zero false injections or provider errors. It makes 166
provider calls; median/p95 per-query latency is 14.2/21.3 seconds in this run.

The [final full Codex run](verified-quality-codex-provider-error.json) fails the strict gate
on one provider error: `scope-tokens` takes 55.6 seconds, consistent with the selector's
55-second child-process deadline. The other 45 answerable corpus/held-out queries have full
recall, with zero false injections, 8/8 correct no-answer abstentions and 4/4 scale cases.
Median/p95 latency is 19.5/26.2 seconds. An [isolated scope retest](verified-quality-codex-scope-retest.json)
passes with full recall, zero false injections/errors and 20.3-second latency. This retest
does not turn the failed full run into a passing gate. Intermittent provider availability
and latency remain limits; failures produce no injected context.

The [focused Markdown run](verified-quality-markdown.json), also with Claude Haiku, passes
all six previously missed answers, four corpus no-answer questions and four scale/adversarial
cases. It reports zero false injections or provider errors, 38 calls and median/p95 latency
of 20.3/38.2 seconds. This is a 14-case backend check, not a second full quality run.

```sh
node scripts/verify-recall-quality.ts --selector /absolute/recall.json --tasks --assert --report /absolute/report.json
```

The assertion requires at least 0.9 recall on every measured answerable query, zero false
injections and provider errors, correct no-answer abstention and all scale cases passing.
Discovery/selection/verification add model calls and latency. Results are bounded synthetic
evidence, not a guarantee for arbitrary data, models or workloads. No Ollama model was evaluated
in this change, and the historical raw S18/S21 gates remain separate.
