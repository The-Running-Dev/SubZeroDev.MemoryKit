# ADR-0004: Optional evidence-based task recall selection

Status: Accepted for this implementation, 2026-11-01.

The native pilot exposed two different lexical misses: a paraphrase without matching words,
and a verbose task whose unrelated terms made the all-term query unsatisfiable. Weakening
the query to any matching word would also retrieve unrelated material. Earlier vector
expansion has not passed the S18/S21 quality gates.

Add a provider-neutral `RecallSelector` application port. For an explicit query it receives
bounded, authorized, current eligible passages and returns IDs/revisions with verbatim
supporting quotes, or an empty selection. Configured selection replaces lexical/vector
ranking for this invocation; abstention and provider failure never trigger a recency fallback.
No-query browsing stays deterministic. Default retrieval remains model-free lexical search.

Scan at most `candidateLimit` current records (default 200), disclose at most 32 passages,
2048 code points per passage and 64 KiB of serialized query/passages/limit. Report omissions
as partial completeness. Scan order is storage's recent ordering: this is bounded selection,
not a scalable semantic index, and older or clipped facts can be missed. Selected IDs must
belong to the supplied set, have the same revision, be unique and cite a nonempty exact
substring. Re-read records before injection and drop changed/ineligible revisions. Quotes
establish extractive provenance, not truth or a guarantee of relevance. Output retains the
existing untrusted envelope and complete-envelope byte budget.

Only trusted local profile configuration or an SDK caller selects the provider. HTTP/MCP
request data cannot select executables. Ship command adapters for existing Ollama models
and an existing Claude Code login; any model can implement the JSON protocol. A calling
host need not match the selector's provider. No model is installed or selected automatically,
no raw memory is rewritten, and no persistent derived index is created. Provider calls add
latency/cost and disclose scoped passage text to the chosen provider, so activation is explicit.

Extend native acceptance to Codex with an isolated temporary home, existing login only,
disabled tools/rules, synthetic random markers and reviewed generated hooks. The documented
one-invocation hook trust flag applies only to these test hooks. Test both observed hook
events and an unwrapped generated command. Record exact, paraphrase, verbose task, scopes,
correction and no-answer outcomes; preserve the historical misses. These fixtures do not
replace broader held-out relevance, adversarial or scale evaluation.
