# ADR-0003: Query memory at prompt submission

Status: Accepted for this implementation, 2026-11-01.

SessionStart has no current task. Injecting recent accepted records there can supply unrelated
memory, and accepting a query in the shared workflow does not make the native host use it.

Generate Claude Code and Codex UserPromptSubmit command hooks. Read the host's `prompt`,
normalize whitespace, and bound the search prefix to the existing 1024-code-unit query limit.
Do not add query rewriting, alter core lexical ranking, or claim improved semantic quality.
Empty/non-searchable prompts and unmatched queries emit nothing. The response names the actual
event and uses the host's `additionalContext` contract. Existing scope, acceptance, lifecycle
and complete-envelope byte limits apply. All hook failures remain nonblocking exit 1.

Default SessionStart recency is removed. It requires explicit `startupContext:true` and a
registered SessionStart hook; `context:false` disables both recall paths. Existing installations
must regenerate/merge the new prompt-hook fragments. Setup still never edits live settings.
Codex requires review/trust of the changed hook definition through `/hooks`.

Validate both hook adapters in subprocesses and packed consumers. Separately run an opt-in
native Claude Code pilot with isolated settings, disabled tools/MCP, synthetic data and the
installed CLI. Observe actual hook input/output and require the model to return an unpredictable
recalled value. Native Codex acceptance remains separate from its subprocess contract coverage.
Measure exact, paraphrase, no-answer and verbose-task retrieval on the synthetic fixture;
these observations do not replace the failed S18/S21 quality gates.

Contracts: [Claude Code hooks](https://code.claude.com/docs/en/hooks#userpromptsubmit),
[Codex hooks](https://learn.chatgpt.com/docs/hooks#userpromptsubmit).
