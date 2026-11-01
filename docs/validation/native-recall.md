# Native task-aware recall acceptance

## Initial lexical pilot

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

## Follow-up: task selection and native Codex

The follow-up uses the same synthetic fixture with the optional provider-neutral recall
selector enabled. Both CLI and provider example were packed and installed separately from
the checkout. Selector: Claude Code's existing login, `--model haiku`, tools/MCP/settings
sources disabled, structured JSON output. This also exercises interoperability: native Codex
consumes MemoryKit context selected by a different model provider.

| Native host | Version | Acceptance |
| ----------- | ------- | ---------- |
| Codex       | 0.158.0 | 9/9 passed |
| Claude Code | 2.1.302 | 8/8 passed |

Both repeat the six original cases and add paraphrase and verbose-task model-visible recall.
Codex additionally runs the generated shell command without the observation wrapper. Its
zero `contextBytes` field means uninstrumented output, not an empty injection; the unpredictable
corrected value must still appear in the model answer. Wrapped Codex cases execute the
generated command through PowerShell on Windows (`/bin/sh` elsewhere), recording the actual
event and envelope. The extra unwrapped case verifies the native host's own shell invocation.

| Fixture category | Lexical pilot relevant/expected | With selector, both hosts |
| ---------------- | ------------------------------- | ------------------------- |
| Exact            | 1/1                             | 1/1                       |
| Paraphrase       | 0/1                             | 1/1                       |
| Verbose task     | 0/1                             | 1/1                       |
| No answer        | 0 records injected              | 0 records injected        |

Reports: [Codex](native-codex-selection-2026-11-01.json),
[Claude Code](native-claude-selection-2026-11-01.json). Random values and local paths are omitted.
These are small wiring/regression fixtures, not held-out semantic quality or cost gates.
Model output remains nondeterministic. Default lexical behavior and its recorded misses
remain unchanged unless a selector is configured. Bounded recent candidate scans can still
miss older facts; this does not establish scalable search or pass S18/S21.

To reproduce, create a selector JSON file containing the `recall` object's value from
[the profile example](../portable-memory.md#task-aware-selection-for-paraphrases-and-longer-prompts),
using the **installed** provider example path:

```bash
node --no-warnings scripts/verify-native-recall.ts \
  --cli /absolute/path/to/install/node_modules/subzerodev-memorykit/dist/cli/main.js \
  --host codex --codex /absolute/path/to/codex-executable \
  --selector /absolute/path/to/selector.json \
  --report /absolute/path/to/native-codex.json
```

For Claude Code use `--host claude-code --claude /absolute/path/to/claude-executable`.
Each selected run makes 8 (Claude) or 9 (Codex) host calls, plus selector calls in recall
and four descriptive retrieval measurements. It uses existing host authentication; no model
is downloaded. Native runs stay outside credential-free CI.

Codex gets an isolated temporary `CODEX_HOME` containing only a copy of the existing login,
the test configuration and reviewed test hooks. Global config, hooks, rules, MCP servers and
sessions are never copied or modified. The harness disables shell/apply-patch tools, web
search and rules, requests ephemeral execution and rejects unexpected tool/error items in
JSONL output. It permits only the exact notice associated with its invocation-scoped
`--dangerously-bypass-hook-trust` flag. This documented automation flag is used only after
reviewing the generated/wrapper hook source outside Codex; it never changes persistent trust.
The temporary home, copied login and synthetic store are removed in `finally`.

References: [Codex hook trust](https://learn.chatgpt.com/docs/hooks#review-and-trust-command-hooks),
[Codex configuration](https://learn.chatgpt.com/docs/config-file/config-reference).
