# S22 — Portable memory across projects and hosts

Owner-authorized scope, 2026-11-01. This closes the end-user capture/context gap without
replacing the existing service, reviving retired S19/S20 or claiming passed model quality gates.

## Contract

- `capture(client,input,distiller?)`: one exact namespace; stable host/session/event/source
  and observation IDs; source roles and refs; 1..100 nonempty observations. Validate the
  whole batch before provider calls/writes. Generated output is revalidated and cannot
  emit accepted status or wider scopes. Empty distilled output is a successful no-op.
  Candidate writes use content-independent operation IDs. Return per-item outcomes/failures
  and complete/partial; retry identical events without overwriting later revisions.
- `context(client,input,embedding?)`: one exact project namespace plus at most 16 explicit
  shared namespaces. Accepted active records by default; explicit candidate opt-in.
  Exclude inactive/rejected/superseded records. Query uses existing lexical retrieval;
  no-query uses bounded recent search. Optional semantic expansion uses authorized current
  records, finite vectors and RRF k=60, with no persistent vector copy or answerability claim.
  Default candidate bound 200 (max1000), item bound10 (max50), envelope8192 bytes (512..65536).
  Return items, namespaces, exact UTF-8 bytes, retrieval mode/provider and omission reasons.
- `accept(client,id,expectedRevision)`: merge accepted metadata through the existing update
  operation and optimistic revision check. Acceptance is a caller action, not verification.
- `planClaudeMemImport`/`importClaudeMem`: explicit source installation ID and exact project
  mappings; preserve observations/summaries/prompts and attribution; session ownership joins
  must be unambiguous. Validate all selected records before writes; use capture identities.

The conventions use application metadata, not mandatory core fields. HTTP capture returns
200 on complete writes, 202 on complete writes with pending history, 207 on partial failures.
Context returns 200 including its own completeness. Domain errors remain structured problems.
HTTP/MCP never execute model commands selected by tool/request arguments.

## Adapters and acceptance

1. SDK, CLI, HTTP and MCP invoke the same workflows; any model can be an explicit caller.
2. CLI setup writes a profile and reviewable Claude/Codex/MCP fragments without modifying
   live settings. Capture defaults off. Generated Git/none history choice is consistent.
3. Claude/Codex UserPromptSubmit recalls context using a normalized, bounded prompt query.
   SessionStart recency is explicit opt-in (`startupContext`); `context:false` disables both.
   Blank/non-searchable prompts and no matches emit nothing, without a recency fallback.
   Opt-in Stop/PreCompact capture bounded transcript
   user/assistant text. Tool/system/private/context content is omitted. Failures do not block hosts.
4. Source role and generated status stay separate. Corrections/lifecycle and explicit shared
   scope are honored. Context treats memory as untrusted data and budgets the complete envelope.
5. Trusted command providers are optional infrastructure with stdin/stdout JSON, no shell,
   bounded execution/input/output and sanitized failures. Ship an optional Ollama example.
6. Verify actual cross-process Claude capture to Codex recall, retries/acceptance/project
   isolation, migration, malformed input, provider failures, HTTP/MCP and packed consumers.
7. Run an opt-in installed Claude Code acceptance harness against a packed CLI and synthetic
   store: actual prompt event, model-visible random value, fresh processes, project/shared
   scopes, correction and no answer. Keep model calls outside normal credential-free CI.
   Describe fixture relevance/paraphrase/verbose-task results without changing S18/S21 gates.

No automatic acceptance, semantic deduplication, recommended embedding model, persistent
vector indexing, universal host lifecycle hooks or npm publication is included. S18/S21
quality results remain failed; synthetic provider tests establish wiring and isolation only.
