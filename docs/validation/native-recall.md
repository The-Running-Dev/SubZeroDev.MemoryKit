# Native task-aware recall acceptance

Run on Windows with Node 26.12.1 and installed Claude Code 2.1.302, 2026-11-01.
The CLI was packed with `npm pack`, installed into a separate directory with npm, then
passed to the harness. This uses the existing Claude Code login and makes six model calls.
It does not call an API directly, download a model, or edit global host settings.

```bash
node --no-warnings scripts/verify-native-recall.ts \
  --cli /absolute/path/to/install/node_modules/subzerodev-memorykit/dist/cli/main.js \
  --report /absolute/path/to/native-recall.json
```

Use `--claude /absolute/path/to/claude.exe` if needed. Native execution is opt-in, outside
`npm test`. The harness creates and removes an isolated synthetic store and Git projects.
Claude settings sources, other MCP servers, tools and session persistence are disabled for
the invocation; normal authentication remains available. Capture stays off.

The generated prompt-hook command is wrapped to observe the host's actual event and the
installed CLI's unchanged output. The model must return an unpredictable value present only
in recalled memory. The fixture also asserts the exclusion of private/unselected scopes and
unrelated content. Six of six cases passed:

- Initial prompt recall and another fresh host process.
- A different project sees its own value.
- An explicitly selected shared namespace is recalled.
- A question without a matching memory injects zero bytes and produces MISSING.
- A replacement revision is recalled after restarting; the old value is absent.

The machine-readable [result](native-recall-2026-11-01.json) omits random values and local paths.
It includes four descriptive lexical retrieval measurements: exact recall 1/1, paraphrase
0/1, no-answer injection 0 records, verbose-task recall 0/1. These tiny synthetic observations
establish wiring and known limitations, not a general quality score or a passed S18/S21 gate.
Concise task queries remain more reliable than arbitrary long instructions; the prefix bound
can also omit relevant terms near the end of a prompt. Semantic expansion remains experimental.

Codex's native model loop was **not** run in this pilot. Its event adapter is covered by real
CLI subprocess tests (prompt response contract, fresh opens, scopes, corrections and failures).
The package check also executes a generated prompt hook from an installed tarball without a
model. Neither is claimed as native Codex acceptance. Contract references:
[Claude Code](https://code.claude.com/docs/en/hooks#userpromptsubmit),
[Codex](https://learn.chatgpt.com/docs/hooks#userpromptsubmit).
