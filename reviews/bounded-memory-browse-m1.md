# Bounded memory browsing — M1

Deliverable: Bounded attributed memory browsing across SDK, CLI, HTTP and MCP
Risk: HIGH — authorization boundaries and lifecycle eligibility govern disclosed memory data.

## Verification

Syntax: passed — TypeScript typecheck and ESLint completed on 2026-11-09.
Unit: passed — The 16 browse cases cover allowlisted projection, filters, pagination, Unicode bytes, overflow retry, candidate opt-in and scan limits.
Integration: passed — Full suite reported 426 passed, 1 stale MCP inventory failure (F1) and 3 PostgreSQL skips without a local database. After C1 and integration with main, all 40 affected browse/MCP/provider tests passed. Installed-package validation also passed on the integrated branch, including CLI, prompt hook, public-entry isolation, typed workflow consumers, storage plugins and Git-history composition.
Entry point: passed — Real CLI browse with cross-process cursor resume, HTTP response equivalence and stdio MCP browse ran successfully.
End to end: passed — The integrated branch's synthetic SDK/HTTP/real CLI/stdio MCP tests passed. Existing retrieval evaluation with 0 and 10,000 filler notes exited 0 and met every hard safety threshold; quality target misses are recorded in docs/validation/bounded-browse.md. Real-model qualification is outside this change.
Risk check: passed — SQLite and Markdown tests cover foreign namespaces, authorization/filter-bound continuation, current revision and eligibility rechecks, attribution and complete compact JSON byte limits.

## R1

Kind: review
Revision: e9c491ad54fcc27753073d9afcd608802692bd5a plus the M1 working-tree implementation reviewed on 2026-11-09.
Scope: Browse workflow, internal client identity binding, four public surfaces, tests and bounded-browse ADR.
Outcome: No actionable findings. Exact scopes, accepted defaults, attributed allowlisted summaries, explicit candidate/preview options, whole-result UTF-8 bounds, retained overflow items, bounded scanning, cursor binding and current-record revalidation meet the acceptance criteria.
Continuity: The interrupted 2026-11-03 R1 was resumed, not restarted. A later full-suite verification found F1; its single correction is recorded below.

## F1

Severity: BLOCKING
Status: resolved
Raised in: verification
Revision: e9c491ad54fcc27753073d9afcd608802692bd5a plus M1 changes.
Where: tests/mcp.test.ts, supported memory tools inventory test.
Claim: The inventory assertion still expects 16 tools after adding memory_browse.
Evidence: Full npm test on 2026-11-09 failed with AssertionError: 17 !== 16 at tests/mcp.test.ts:296; the name-list equality passed.
Consequence: The otherwise successful full suite cannot pass its MCP inventory check.
Correction: Update the expected count to 17; keep exact tool-name equality and schema checks. Rerun the MCP suite.

## C1

Revision: f64184fd744fecd89674929212d0bc3e8d8ab8f7 plus M1 changes.
Findings: F1
Change: Corrected the stale MCP inventory assertion from 16 to 17. No production behavior changed.

## R2

Kind: re-review
Revision: f64184fd744fecd89674929212d0bc3e8d8ab8f7 plus M1 changes.
Scope: F1 and C1 only.
Outcome: Correction verified by independent inspection: expected count is 17, exact name equality and schema checks are intact, and no production behavior changed. The parent subsequently confirmed all 40 affected tests passed. No additional findings.

## Integration

Notes: Main advanced while this work was paused. The branch was fast-forwarded to f64184f and M1 reapplied without conflicts. ADR 0010 was renumbered to 0012 to preserve the intervening decisions; the browse implementation is unchanged. Post-integration validation includes the new provider example tests as well as the affected browse/MCP suites.
