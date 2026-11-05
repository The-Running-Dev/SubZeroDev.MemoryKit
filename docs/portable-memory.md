# Portable memory

One store can serve unrelated projects, different models and conventional applications.
The portable workflow uses the existing authorized service, with no required model or
second database. The package remains unpublished. Node 22.18 or later is required.

## Install and connect hosts

```bash
npm ci
npm pack
npm install -g ./subzerodev-memorykit-0.2.0-rc.1.tgz
memorykit setup --store /absolute/path/store --output /absolute/path/config --capture --include-candidates
```

Windows paths such as `D:/MemoryKit/store` work too. Quote paths containing spaces.
Keep configuration outside untrusted repositories. Setup initializes a missing store and
writes a profile, Claude/Codex hook fragments, common JSON MCP fragment and instructions.
It refuses to overwrite generated files and does not change existing host settings.

Activate each host explicitly:

```bash
memorykit install --profile /absolute/path/config/memorykit.profile.json --host claude-code
memorykit install --profile /absolute/path/config/memorykit.profile.json --host codex
memorykit doctor --profile /absolute/path/config/memorykit.profile.json --host codex --probe
```

Install merges owned groups into `~/.claude/settings.json` or `~/.codex/hooks.json`, preserving
other settings. A manifest next to the profile records exact group ownership. Repeat install
after changing a profile or upgrading the package. Edited/missing owned groups and matching
unowned groups require manual reconciliation; install never guesses ownership by command name.
Remove old manually merged MemoryKit fragments before adopting managed installation.
`--settings /absolute/settings.json` selects an isolated/custom host configuration; repeat the
same override for doctor and uninstall. `--manifest` optionally relocates the ownership record.

In Codex, review and trust hooks through `/hooks` after installation or changes. Doctor's
execution probe runs the generated command in diagnostic mode without capture or model calls.
It verifies execution, not host trust. `lastInvocation` records the last hook entry, not retrieval
success; receipts contain event/time/runtime paths, no prompt or memory content. Claude uses an
executable plus arguments; Codex uses a quoted command string and requires `node` on its PATH.
Adapt the MCP fragment to your host's server configuration separately.

```bash
memorykit uninstall --profile /absolute/path/config/memorykit.profile.json --host codex
```

Uninstall removes only exact owned groups, retaining memories and other settings. It does not
remove MCP entries. Keep the profile/manifest until removal completes. Moving to a new profile
path requires uninstalling the old profile first. `upgrade --profile OLD --output NEW` generates
new configuration for review; install it after removing the old groups. Backups are retained
beside changed settings/manifest files for recovery. Each file replacement is atomic; settings
and manifest together are not a crash-atomic transaction. Serialize administrators. If interrupted,
inspect both files and retained backups/lock before retrying; do not restore an entire old settings
file over newer unrelated changes.

Capture is off unless `--capture` is present. Context includes accepted records only unless
`--include-candidates` is present. Both flags give automatic, visibly unverified observations
between sessions. For curated memory, capture candidates and accept selected records later.
Profile booleans `capture`, `context`, `startupContext` and `includeCandidates` are independent.
Default recall runs on `UserPromptSubmit` and uses the submitted task as the query.
Recent-memory injection at `SessionStart` requires `--startup-context` during setup,
or `"startupContext": true` plus a SessionStart hook. `"context": false` disables both.
The default fragments contain only UserPromptSubmit unless capture or startup context is enabled.
Git history is the default; `--history none` selects SQLite-only operation in the profile
and generated MCP configuration. History selection must be supplied on every open.

## Projects and shared memory

An unpinned profile derives `project/<owner>/<repo>` from Git origin (HTTPS, SSH URL or SCP
syntax), matching the existing AgentKit convention. Identical owner/repository paths on
different hosting services require explicit namespaces to avoid collision. Projects without
a supported origin require `--namespace`. A pinned `namespace` always selects that project;
use unpinned profiles across repositories.

Context reads the project plus up to 16 explicitly selected shared namespaces:

```json
{
  "version": 1,
  "store": "/absolute/path/store",
  "capture": true,
  "includeCandidates": true,
  "sharedNamespaces": ["personal/preferences", "team/engineering"],
  "maxBytes": 8192,
  "limit": 10
}
```

Capture writes only the selected project; workflows never discover other projects or write
automatically to shared namespaces. Curate shared records through existing create/update/
supersede APIs. Scope selection is not authorization: local embedded access has full authority.
For access control between users or machines, use the existing authenticated service and
namespace grants. Remote profiles use `url` and optionally `tokenEnv` instead of `store`;
the named environment variable holds credentials. A remote service must be running.

## Any LLM or application

Hosts without lifecycle hooks call the same workflow explicitly. Capture JSON has stable
source/event/observation identities and attributed content:

```json
{
  "namespace": "project/acme/app",
  "source": {
    "host": "my-agent",
    "sessionId": "s123",
    "eventId": "turn7",
    "ref": "conversation:s123/turn7"
  },
  "observations": [
    { "id": "preference", "role": "user", "content": "Use SQLite for integration tests." }
  ]
}
```

```bash
memorykit capture --profile /absolute/path/config/memorykit.profile.json --namespace project/acme/app --input capture.json
memorykit context --profile /absolute/path/config/memorykit.profile.json --namespace project/acme/app --text "integration tests" --include-candidates
```

`--input -` reads stdin. `context --text-output` emits just the context envelope. No query
selects recent eligible records; a query uses lexical retrieval and optional semantic expansion.
SDK exports: `capture(client,input,distiller?)`, `context(client,input,embedding?,selector?,index?)`,
`accept(client,id,expectedRevision)`, `reviewQueue`, `reviewMemory`, `planClaudeMemImport`,
`importClaudeMem` and `reconcileClaudeMem`.
Use `connect(url,{token})` for a remote authorized client. HTTP exposes `POST /v1/capture`
and `POST /v1/context`; MCP exposes `memory_capture` and `memory_context`. Server requests
cannot select executables. Custom providers over a remote store run through SDK/CLI orchestration.

Capture validates a whole batch before writing, then reports per-item outcomes/failures.
Successful items are not rolled back on a later failure. Retry an identical batch to resume.
Identity is independent of content: changed content with the same identity causes
`IdempotencyMismatch`, not an overwrite. Accepted revisions survive retries. Replays return
the original write outcome; read the current record for current status. CLI exit 1 denotes
errors/partial capture; HTTP returns 207 for partial capture and 202 for complete writes
with pending history. Inspect individual write history status.

Codex transcript capture uses timestamp, role, full content and an occurrence counter
for observation identity. Evidence uses `codex:session:SESSION_ID`, so moving or rewriting
a resumed transcript preserves the idempotent request. Profiles created before this change
used byte offsets and file references; retained messages can be recaptured as candidates
after upgrading. Review these candidates before accepting them.

## Capture, review and correction

```bash
memorykit review --profile /absolute/config/memorykit.profile.json --namespace project/acme/app
memorykit review --profile /absolute/config/memorykit.profile.json --namespace project/acme/app --json --limit 20
memorykit review accept RECORD_ID --profile /absolute/config/memorykit.profile.json --namespace project/acme/app --expected-revision 1
memorykit review reject RECORD_ID --profile /absolute/config/memorykit.profile.json --namespace project/acme/app --expected-revision 1
memorykit review correct RECORD_ID --profile /absolute/config/memorykit.profile.json --namespace project/acme/app --expected-revision 2 --text "Reviewed correction"
memorykit review duplicate RECORD_ID --profile /absolute/config/memorykit.profile.json --namespace project/acme/app --expected-revision 1 --duplicate-of ACCEPTED_ID
```

The queue shows candidate text, source role, generated/curated status, evidence references,
current revisions and exact normalized-text duplicate suggestions in one namespace. Follow
`nextCursor` with `--cursor`; duplicate comparisons cover at most 100 current records and report
when limited. Suggestions never merge automatically. Duplicate resolution rejects the selected
candidate only after checking an active accepted identical-text target in the same namespace.
It does not delete either source or merge semantically similar claims.

All actions require the revision displayed during review. Refresh after a conflict. Correction
atomically supersedes the original, creates an accepted replacement, retains provenance/source
role and marks the new statement as reviewer-curated (`correctedFrom`, `correctionSource`).
Acceptance changes workflow eligibility; it does not authenticate or independently verify a claim.
The SDK exposes the same queue/actions through any authorized MemoryClient, including remote
connections. Raw HTTP/MCP lifecycle operations remain available; there are no separate remote
review endpoints. Review does not enable automatic capture or candidate injection.

UserPromptSubmit injects matching context through `additionalContext`. Empty, whitespace-only
and punctuation-only prompts inject nothing; no match also produces no stdout. It never falls
back to recent memories. Prompt whitespace/control characters are normalized, then a prefix
of at most 1024 UTF-16 code units is used, without splitting a surrogate pair. A truncated
query is reported on stderr. Hook input is bounded to 64 KiB. Default retrieval is lexical;
paraphrases and verbose prompts can miss relevant records. Configure the optional `recall`
selector below to evaluate task relevance without requiring overlapping terms. Optional
embedding behavior remains experimental, including its answerability limitations.

To upgrade fragments generated before task-aware recall, regenerate configuration with the
existing store and provider/shared-scope options, then use managed installation above.
Old SessionStart hooks are silent unless
`startupContext` is explicitly enabled. Other hosts can use `memory_context` or CLI
`context --text` with a concise task query; installing a model alone does not register native hooks.

Stop and PreCompact capture text
when enabled. Hook failures exit 1, never the host-blocking exit 2. No background observer runs.
The parser reads the final 2 MiB, selects the last 100 user/assistant messages and clips each
to 8192 UTF-8 bytes, reporting omissions on stderr. Tools, system messages, sidechains,
malformed rows, `<private>` messages and injected MemoryKit context are excluded. This is
not a secret detector: enabled capture can retain private information in ordinary messages.

Records retain source role, host/session/event/observation and evidence references. Assistant
text never becomes a user assertion. Distilled output is labelled generated; all capture and
import output starts as candidate. Provenance is caller-asserted, not proof. Evidence refs
are pointers rather than copied attachments.

```bash
memorykit accept MEMORY_ID --profile /absolute/path/config/memorykit.profile.json --namespace project/acme/app --expected-revision 1
```

Acceptance uses optimistic revision checks, not independent verification. Existing `update`,
`supersede`, `archive`, `tombstone` and `purge` commands support curation. Correct through a
new revision or supersede; do not reuse a capture identity with different content. Raw commands
use `--store`/`--url` and optional `--history none`, rather than a workflow profile.

Context excludes superseded, archived, tombstoned, rejected and unlabelled records. Defaults
are 10 items/8192 bytes, maxima 50/65536. The UTF-8 budget includes the serialized envelope,
attribution and evidence. Truncation and candidate/item/evidence limits are reported as partial
completeness. Recent/semantic scans default to 200 candidates, adjustable to 1..1000 through
SDK/HTTP/MCP `candidateLimit`. Lexical hits are re-read and revision-checked. Context is not a
transactional snapshot across concurrent writers. The envelope marks data as untrusted and
escapes stored delimiters; consumers must still treat it as evidence rather than instructions.

## Import claude-mem

After importing, audit the same explicitly selected export and mapping without changing records:

```bash
memorykit reconcile-claude-mem --profile /absolute/config/memorykit.profile.json --input export.json --mapping mapping.json --source-id my-installation
```

The report identifies matched, missing, changed or ambiguous selected source rows, retaining
their current review/lifecycle state. Truncated scans report unknown coverage instead of declaring
success. `ready` means complete coverage of the selected input, including retained superseded
sources; it does not mean every record is accepted, all upstream data was exported, or retrieval
quality is sufficient for cutover. `extraRecords` can include curated replacements carrying source
metadata. Reconciliation never overwrites corrections or imports changes automatically.

For cutover, retain the original export and claude-mem configuration/database privately, review
candidates, test your own queries and confirm source coverage. Disable claude-mem hooks only
when ready to switch; MemoryKit does not disable another tool. For rollback, uninstall MemoryKit's
owned hooks and restore your saved upstream configuration yourself. Portable MemoryKit archives
can also restore reviewed records/history into a fresh supported backend; they are not upstream
database backups. Never overwrite a running store during rollback.

Use JSON from [claude-mem's export script](https://github.com/thedotmack/claude-mem/blob/main/scripts/export-memories.ts).
Observations, summaries and prompts are imported with original row fields; sessions supply
project ownership only. Prompts retain user attribution; observations/summaries are generated
assistant material. A query-filtered export contains only selected data, not a full backup.
The importer does not read the live database, stop claude-mem or copy vector indexes/settings.

Write a mapping file, e.g. `{"my-source-project":"project/acme/app"}`:

```bash
memorykit import-claude-mem --profile /absolute/path/config/memorykit.profile.json --input export.json --mapping mapping.json --source-id laptop-claude-mem --dry-run
memorykit import-claude-mem --profile /absolute/path/config/memorykit.profile.json --input export.json --mapping mapping.json --source-id laptop-claude-mem
```

Keep `--source-id` stable across exports from that installation. Repeated `--project` filters
source projects. Missing mappings, ambiguous ownership, duplicate identities and malformed
rows fail before writes. Input is capped at 16 MiB and 10,000 selected records. Retry identical
rows/source identity to resume; changed rows require reconciliation rather than overwriting
curation. Imports remain candidates. Unexported attachments are not migrated.

## Optional model providers

No model is required. Implement SDK `Distiller`/`EmbeddingProvider`/`RecallSelector`, or configure a trusted
executable and argument array in a CLI profile. `subzerodev-memorykit/providers-command`
runs without a shell and exchanges one JSON request/response through stdin/stdout. Commands
inherit the environment; do not let untrusted repositories supply profile commands.

- Distillation request: `{version:1,task:"distill",input:<CaptureInput>}`; response:
  `{observations:[{id,role,content,kind?,evidence?}]}`. Empty means nothing durable. Output is
  validated before writes and forced to generated/candidate status; it cannot widen scope.
- Embedding request: `{version:1,task:"embed",role:"query"|"document",texts:[...]}`; response:
  `{vectors:[[...],...]}`. Finite, consistently dimensioned vectors must share a compatible space.
- Recall request: `{version:1,task:"select",query,limit,passages:[{id,revision,namespace,content,truncated}]}`;
  response: `{selections:[{id,revision,quote}]}`. Return useful passages ordered by relevance or
  `{selections:[]}` to abstain. Each quote must be an exact, nonempty substring of the supplied passage.
  `CommandRecallSelector` implements this protocol; the workflow checks membership, uniqueness,
  revision and quote, then re-reads the selected current records before rendering context.

### Task-aware selection for paraphrases and longer prompts

Add `recall` to the generated profile to enable model-assisted selection. The caller can be
Codex, Claude, another LLM or an ordinary application. Selection replaces lexical/embedding
ranking for queries; an abstention stays empty. No query still uses recent browsing without
calling a model. Provider errors fail explicitly (nonblocking exit 1 in a hook), with no fallback.

Example using an existing Claude Code login, independent of the calling host:

```json
{
  "recall": {
    "id": "claude-haiku-selector-v1",
    "discovery": true,
    "verification": true,
    "command": {
      "command": "node",
      "args": [
        "/absolute/package/path/examples/claude-recall.mjs",
        "--claude",
        "/absolute/path/to/claude-executable",
        "--model",
        "haiku"
      ],
      "timeoutMs": 28000
    }
  }
}
```

Use a native executable on Windows, not a `.cmd`/`.ps1` shim. This example creates a temporary
working directory, disables settings sources, hooks, tools, MCP and session persistence, and
uses structured output. It uses the existing login, makes a billable/plan-accounted model call,
and never installs a model or edits host settings. Its own call timeout defaults to 90 seconds;
the whole context deadline can expire earlier.
Discovery makes an additional query-expansion call. Optional `verification:true` makes a
separate audit call over proposed passages only, allowing abstention or exact-quote repair.
It cannot add records, change scope or resurrect an obsolete revision. Injection contains only
the verified contiguous quote. The compact adapters return a whole bounded passage as that
quote, which can retain incidental text inside the passage. Verification
is opt-in and adds latency and provider cost. Run `install` again after changing recall
configuration to update owned hooks: the prompt hook budget is the total context deadline
plus thirty seconds for shell/Node startup, store opening and cleanup. Slower calls fail
without injecting context. The measured two-call experiment without verification failed one
abstention case; keep verification enabled for the tested daily configuration.

For local selection use the same `recall` entry with `examples/ollama-provider.mjs --model
YOUR_INSTALLED_CHAT_MODEL` instead, or supply any trusted executable implementing the protocol.
The Ollama adapter supports selection as well as distillation/embedding; model quality is the
operator's choice. The actual Qwen2.5 7B smoke test passed three small installed-SDK checks;
no local model has passed the full task gate here. See the
[daily results and retained failures](validation/daily-replacement.md#actual-independent-local-model).

Selection starts with at most 200 recent records by default and searches the full scoped
lexical index with up to sixteen task terms. `discovery:true` additionally sends the query
alone to the provider for up to eight bounded search queries. Search ranks are fused; older
indexed hits receive disclosure slots alongside recent candidates. Long records use a window
around query terms. The provider receives at most 32 passages of 2048 code points each with
a total serialized input budget of 64 KiB. Only explicit namespaces and eligible statuses
reach it; candidate opt-in still applies. These bounds can still omit older or clipped facts.
Discovery truncation and candidate bounds are reported, alongside omission reasons
`selection_input_limited`/`selection_content_limited` are visible as partial completeness.
Quotes check provenance, not truth or semantic correctness. Model mistakes and prompt injection
remain possible; returned content stays untrusted data. Selection is bounded retrieval,
not a persistent semantic index. See [native acceptance](validation/native-recall.md) for
the exact fixture results and their limits.

An independent second selector uses an existing Codex login: configure the same command
shape with `examples/codex-recall.mjs --codex /absolute/native/codex-executable` and
`timeoutMs:110000`. It copies existing authentication and optional native catalog metadata into an isolated temporary home,
disables tools, rules and web access, and uses structured output. Its internal timeout is
90 seconds per call, configurable with `--timeout-ms` (1000..110000). Set the outer command
deadline above the adapter deadline. On Windows use the native `codex.exe`, rather than npm's `.cmd` shim.
Optional `--model` chooses an explicitly available model. It does not install models or
change global configuration. Query expansion uses `{version:1,task:'expand',query}` and
returns `{queries:[...]}`; selection retains the existing `select` protocol. Expansion is
optional for other adapters and receives no memory passages.

The Codex adapter also seeds the existing native `models_cache.json` into its isolated home;
Codex validates cache freshness, executable version and provider/account identity. This copies
no sessions, rules or user settings and does not cache retrieval. `--fresh-model-catalog`
disables the seed for comparisons. Both Codex and Ollama accept an optional `--timings`
JSONL path for numeric lifecycle/server timings without prompt or answer content. See the
[cold latency investigation](validation/cold-latency-investigation.md) for measurements,
limitations and unchanged full qualification commands. No new readiness result is implied.

Run `node scripts/verify-recall-quality.ts --selector /absolute/recall.json --report
/absolute/report.json` to measure a recall-profile object against existing eligible corpus
and heldout queries plus facts behind 1,000 newer notes and adversarial no-answer cases.
This is opt-in and makes real provider calls. It reports skipped raw-search-only features,
recall, false injections, provider errors, latency and payload bytes (not billing tokens).
See [portable storage and discovery validation](validation/portable-storage.md) for native
Markdown results and the preserved initial quality reports.
Storage configuration and repeatable installation are described in [storage plugins](storage-plugins.md).

### Distillation and embedding

An optional durable embedding cache uses the public `EmbeddingIndex` port. Add an absolute
`"index": "/private/path/vectors.sqlite"` inside the profile's `embedding` object. The bundled
implementation is `SqliteEmbeddingIndex` from `subzerodev-memorykit/index-sqlite`; SDK callers
pass it as the fifth `context` argument. SDK callers must choose a bucket identity scoped to
their store, principal, exact namespaces and model/version. CLI derives this bucket from the
store/service, credential hash, scopes, candidate eligibility and provider ID. Change the provider
ID when changing model/version. Do not share a bucket across authorization contexts.

Only document vectors and opaque hashes persist. Keys bind model ID, namespace, record ID,
revision and clipped content hash; every emitted record is read and revision-checked again.
Query vectors are recomputed. Stale/removed entries are pruned after the next complete candidate
scan; bounded/partial scans preserve unseen entries. `memorykit index-clear --profile PROFILE`
clears the current bucket explicitly. Other scopes/models/principals have separate buckets;
administrators can remove an unused cache file while closed. Vectors can reveal sensitive
information: protect the file and include it in deletion procedures. Source purge prevents stale
injection immediately, but is not immediate physical erasure of cached vectors or SQLite/WAL
pages/backups. This caches the bounded embedding candidate scan; it is not a global vector
search engine and does not improve selector-mode discovery. No index is enabled by default.

Distillers should return stable IDs/content for identical inputs. Changed output conflicts
instead of replacing prior memory. Host distillation hashes the selected transcript snapshot
as event identity; later snapshots can add repeated information. This is not semantic
deduplication or incremental extraction.

Document embeddings are batched by 32 and clipped to 8192 code points with visible omission
reporting. Vectors are ephemeral unless an index is explicitly configured below. Providers receive
selected authorized content, so choose endpoints consistent with your privacy requirements.
Each command defaults to 30 seconds (maximum 120), input 8 MiB, output 4 MiB (maximum 16).
Multiple batches have separate timeouts. Failures are explicit; provider diagnostics are
suppressed because prompts/output can be private.

Recall profiles optionally set `"retries": 1` (default 0). Only a per-command timeout or
reserved adapter timeout exit code 75 triggers one retry. Invalid output, schema errors and
other process failures are never retried, and there is no retrieval fallback. Codex and Ollama
examples map their internal deadlines to 75. Retries share the total context deadline; its
expiration is never retried. Generated prompt hook budgets add thirty seconds to that total
for startup and cleanup. Regenerate installed hooks after changing these values. Quality reports distinguish
logical calls from process attempts/retries; payload bytes are not token or billing accounting.
`verification:false` skips the optional audit call; validate that tradeoff with the full quality
gate before choosing it for daily use.

The packed `examples/ollama-provider.mjs` works with an already-running Ollama and explicitly
chosen installed models; it downloads nothing. Add either/both optional profile entries:

```json
{
  "distiller": {
    "command": "node",
    "args": ["/absolute/package/path/examples/ollama-provider.mjs", "--model", "YOUR_CHAT_MODEL"]
  },
  "embedding": {
    "id": "YOUR_EMBEDDING_MODEL_AND_VERSION",
    "command": {
      "command": "node",
      "args": [
        "/absolute/package/path/examples/ollama-provider.mjs",
        "--model",
        "YOUR_EMBEDDING_MODEL"
      ]
    }
  }
}
```

The example defaults to loopback; `--url` explicitly chooses another endpoint. Requests default
to 25 seconds; `--timeout-ms` selects 1000..110000 milliseconds for slower local hardware.
Keep the outer command deadline higher. It uses
documented Ollama [chat](https://docs.ollama.com/api/chat) and
[embedding](https://docs.ollama.com/api/embed) APIs and preserves original message roles.
Embedding requests disable input truncation. Chat context limits still depend on the chosen
model/server configuration; size that context for the bounded recall request. Other runtimes
implement the same protocol.

Semantic expansion is experimental and opt-in. It combines lexical and positive-cosine
semantic ranks with reciprocal-rank fusion (k=60); it does not guarantee answerability.
S18/S21 quality/cost gates remain failed. Synthetic tests prove integration/isolation, not
real-world relevance. Lexical retrieval remains the default. A recommended model, broad measured
answerability and further automatic host adapters remain follow-up work.

### Reproducing acceptance and quality checks

See [verified portability results](validation/verified-portability.md) for native lifecycle,
audited task recall, cross-backend migration and PostgreSQL evidence.
See [daily replacement results](validation/daily-replacement.md) for managed hooks, review,
source reconciliation, the persistent cache and actual local-model limitations.

`node scripts/verify-recall-quality.ts --selector /absolute/selector.json --tasks --assert
--storage sqlite --report /absolute/report.json` runs the full corpus, heldout and scale cases.
Repeat with `--storage markdown`. The task variant disambiguates six short topic-only queries
without changing records or relevance labels; omit `--tasks` for the original query baseline.
The gate requires no provider errors, zero false injections, at least 90% per-query recall,
complete no-answer abstention and exact scale/adversarial results. Reports identify skips,
transformations, calls, bytes and latency; bytes are not billing/token measurements.
These workflow checks do not supersede the separate historical S18/S21 raw retrieval gates.

`node scripts/verify-native-recall.ts --cli /installed/dist/cli/main.js --host codex
--codex /absolute/codex.exe --selector /absolute/selector.json --storage sqlite
--report /absolute/native.json` exercises installed, regenerated native hooks. For Claude use
`--host claude-code --claude /absolute/claude`. Add `--peer /absolute/OTHER_HOST_EXECUTABLE`
to require the other native host to recall the reviewed correction from the same store.
Runs use synthetic projects and existing host
logins, making real model calls. The lifecycle includes native Stop capture, candidate exclusion,
revision-guarded review acceptance, restart recall, correction and a host-emitted PreCompact
event, plus managed installation, invocation receipts and uninstall. No global
host settings are edited. Capture remains off by default outside this temporary fixture.

`node scripts/verify-replacement.ts --package /installed/subzerodev-memorykit --report REPORT`
tests the pinned synthetic upstream fixture through import, review, reconciliation, retained Git
history, SQLite-to-Markdown migration and fresh-SQLite rollback using installed public exports.
`node scripts/verify-local-recall.ts --package /installed/subzerodev-memorykit --selector CONFIG
--report REPORT` makes actual provider calls for exact recall, unsupported-question abstention,
scope/candidate exclusion and correction after reopening. This small smoke test does not establish
full task recall quality. Both commands use temporary synthetic stores and retain no personal data.

The checked-in `tests/fixtures/claude-mem-upstream-export.json` is generated by the actual pinned
upstream exporter over synthetic worker API responses. Regenerate using
`node --experimental-vm-modules scripts/verify-claude-mem-export.ts`. The fixture test imports,
reviews and migrates its records with provenance and source roles intact. It does not test a
personal database or claim the worker's entire search API returns every stored row; choose an
upstream export query that covers your intended migration and review counts before cutover.

### Attributed review from remote hosts

Any host can use `POST /v1/review/queue` with
`{"namespace":"project/acme/app","limit":20}` and `POST /v1/review` with
`{"namespace":"project/acme/app","id":"MEMORY_ID","expectedRevision":1,"action":"accept"}`.
Both require the usual bearer token. MCP exposes equivalent `memory_review_queue` and
`memory_review` tools over HTTP or stdio. Queue access needs read permission; a decision
also needs write permission. Stdio uses the configured local store's embedded identity.

Actions are `accept`, `reject`, `correct` (add `content`) and `duplicate` (add
`duplicateOf`, an accepted exact-text match in the same namespace). A correction creates a
replacement and supersedes the original atomically. Decisions preserve source role and
provenance; accepting an assistant recap does not turn it into a user statement or establish
independent truth. Inspect the source and obtain the user's decision before calling an action.
Every decision needs the displayed revision; refetch after a conflict. These review endpoints
have no idempotency-key replay contract. After a lost response, fetch the record/queue before
retrying. Pending Git history is reported separately from the committed decision.

### Optional verified recall cache

Add `"cache":"/absolute/private/path/recall-cache.sqlite"` inside an existing `recall`
profile entry. Regenerate installed hooks after profile changes. This caches exact provider
expansion, selection and verification requests for five minutes. Current authorized discovery,
quote validation and the final record/revision/eligibility check still run on every request.
A repeated identical task can avoid model calls; a changed task or passage list is a cold call.
Searches run in bounded parallel batches of four, preserving their original ranking order.
No lexical fallback runs when the selector abstains or fails.

The CLI isolates buckets by store/service, hashed credential, namespace and shared scopes,
candidate policy and full recall configuration. Use a new provider ID when an adapter/model
changes behind the same command. SDK users compose `CachedRecallSelector` with the
`RecallCache` port; they must include those authorization/configuration boundaries in their
own cache bucket identity. Never share one bucket between principals or stores.

This cache contains sensitive quotations and expansion terms. It is opt-in, bounded globally
per file to 64 entries, 256 KiB each (16 MiB of current JSON values); insertion evicts expired
entries. Expired entries are never reused. `memorykit recall-cache-clear --profile PROFILE`
logically clears only that profile scope's bucket. Other buckets, SQLite free pages, WAL and
backups can retain prior bytes. Purging a source prevents stale injection immediately; cache
expiry/clear is not secure physical erasure. Include the closed cache file and its sidecars in
private retention/deletion procedures. Add `--cache` to the full quality harness to measure
cold and immediate repeated-query latency and actual uncached provider attempts separately.

### Bounded cold recall and provider health

An optional `recall` profile can set `"deadlineMs":60000` and
`"budget":{"passages":16,"passageChars":1024,"bytes":24576}`. These are examples to
measure with your provider, not a quality guarantee. Maximum/default disclosure is 32 passages,
2048 code points each and 65536 serialized request bytes. Configured bounds are respectively
1..32, 128..2048 and 1024..65536. The whole context deadline is 1..120000 milliseconds,
default 60000, including discovery, selection, verification and retries. CLI profiles propagate
it to SDK/HTTP context input and native hooks; MCP also accepts `deadlineMs` explicitly.
Regenerate/reinstall owned hooks after changing profile limits. Per-command timeouts remain
separate. Expiry is a provider error, never a successful abstention or a lexical fallback.
Cooperative provider calls are cancelled and later phases do not start. Storage or custom SDK
providers that ignore cancellation may finish background work after the response deadline.

The shipped Codex/Ollama adapters request passage indices rather than generated identities or
quotes, then copy the exact supplied passage text. Verification cannot add a new passage;
the workflow still checks quotes, namespaces, acceptance and current revisions. Whole passages
can include incidental material, within the configured passage/output bounds. Ollama exposes
`--num-ctx` (default 16384) and `--num-predict` (default 1024). A generation reaching its output
limit is an error. Choose a disclosure budget that fits the model's tokenizer and context;
byte counts are not token counts, and a larger window alone does not establish retrieval quality.
Use `--num-gpu N` (0..256) to request a GPU layer count for Ollama recall. Omit it for automatic placement. Measure memory use and latency on the target machine.
An optional `--num-thread` (1..128) sets Ollama's CPU thread count; omit it to retain Ollama's
automatic choice. Measure it on the target machine: more threads can increase latency under
contention. Smaller explicit context/output budgets can reduce resource use but must still
fit the complete request and response. Neither setting changes the relevance rules.

The opt-in `scripts/verify-recall-quality.ts` report includes per-case expansion, selection
and verification durations, including incomplete phases. Its trace also records generated
search queries. Traces contain supplied queries and passages: use synthetic fixtures or keep
them private. Cold means uncached provider calls; model loading and concurrent machine load
can still affect the measurement. Focused runs do not qualify a provider for replacement.

`memorykit doctor --profile PROFILE --provider-probe` explicitly calls the configured selector
with synthetic evidence, checking selection, verification and no-answer behavior. It reads no
stored content for that probe, writes no memories and does not use the recall cache. The usual
doctor store checks still run. Without the flag doctor does not call a model. A passing probe
establishes protocol/health on these examples, not the full quality gate.

### Replacement readiness report

Create a local JSON manifest with absolute paths to reports generated with the same recall
configuration:

```json
{
  "quality": "/absolute/quality.json",
  "nativeCodex": "/absolute/native-codex.json",
  "nativeClaude": "/absolute/native-claude.json",
  "replacement": "/absolute/replacement.json",
  "maxColdP95Ms": 10000
}
```

Then run `memorykit doctor --profile PROFILE --host codex --provider-probe --readiness MANIFEST`
(or `--host claude-code`, plus the usual custom `--settings` if used). It exits 1 while any gate
is blocked. Gates require the full 58 measured task cases with discovery/verification and at
least 1000 newer facts, no provider errors/false injections, correct abstention, recall at least
0.9 per answer case, cold p95 within the chosen threshold, both native-host reports, installed
package migration/rollback evidence, the live synthetic probe and a current local installation.
Focused/smoke reports cannot satisfy the full gate. Missing files remain blocked. Existing
reports without a configuration fingerprint must be rerun; don't edit evidence to make it pass.

Fingerprints hash normalized provider commands/options, disclosure limits and deadlines without
printing command arguments. These are user-supplied local attestations, not authenticated proof;
they do not detect changes behind the same model/executable ID or bind a package build. Keep
the reviewed candidate digest/source manifest separately and rerun evidence after upgrades.
Only the selected host's current local installation is inspected; a historical native report
does not establish another host's present installation or hook trust. No report enables capture,
accepts memory, disables claude-mem or performs a live cutover.

### Daily cutover and rollback rehearsal

Use a dedicated installation directory and a fresh store until the following rehearsal passes.
Keep the current host settings, MemoryKit profile, plugin versions/configuration and original
claude-mem database/export privately backed up. Stop writers before taking a consistent database
backup or portable archive; do not copy an actively written SQLite main file alone.

1. Build the reviewed candidate: `npm ci`, `npm run build`, `npm run check:release`,
   `npm run check:package`. Pack with `npm pack --pack-destination /absolute/candidate-dir`.
   On a clean source commit run `node scripts/prepare-candidate.ts --archive /absolute/candidate-dir/subzerodev-memorykit-0.2.0-rc.1.tgz --output /absolute/candidate-dir/candidate.json`.
   The manifest records the checkout revision and archive digests; it is not a signature or a
   claim that model quality gates passed. Check the validation reports and CI separately.
2. Install those exact bytes in a dedicated Node project with
   `npm install --ignore-scripts /absolute/candidate-dir/subzerodev-memorykit-0.2.0-rc.1.tgz`.
   Compare its SHA-256/SHA-512 with the candidate manifest before installation. Keep the previous
   installation available for rollback. Nothing here publishes to a registry.
3. Run the installed CLI's `setup --store NEW_STORE --output NEW_CONFIG --storage sqlite`
   (or `markdown`, or the explicit trusted plugin/module options). Git history is the default.
   Use a stable, explicit namespace or project origin mapping; do not share a namespace simply
   because two unrelated repositories have the same folder name. Keep capture off initially.
4. Export the source using its supported export format. Prepare an explicit project-to-namespace
   mapping. Run `import-claude-mem --profile PROFILE --input EXPORT --mapping MAPPING --source-id STABLE_ID --dry-run`,
   inspect the plan, then repeat without `--dry-run`. Import creates candidates. Inspect the review
   queue and decide each acceptance, rejection, correction or duplicate explicitly. Re-run
   `reconcile-claude-mem` with the identical source identity and mapping after source changes;
   coverage reconciliation does not accept records or prove their truth.
5. Run `doctor --profile PROFILE`; resolve pending history with `history-sync --store STORE`
   using the same storage options. With writers stopped, `export-store /private/archive.json --store STORE`
   retains portable current state and Git history. Restore it with
   `import-store /private/archive.json --store FRESH_STORE --storage markdown` (or your backend).
   Never test restore over a live store. See [storage plugins](storage-plugins.md) for external
   database identity, backup, migration and fresh-store requirements.
6. From the checkout, run `scripts/verify-replacement.ts` against the installed package, the full
   recall quality gate with the intended provider, and `scripts/verify-native-recall.ts` for each
   intended native host/backend. Include paraphrases, verbose tasks, old records, correction,
   rejection, another project and no-answer tasks. A provider error or false injection blocks
   that provider's daily-use claim; a failed local-model gate remains a failure even if Codex passes.
7. When ready to switch, disable the old writer/hooks through that host's settings, then install
   the new owned hooks with `install --profile PROFILE --host codex` or `claude-code`. Review
   Codex hook trust through `/hooks`; run `doctor --host HOST --profile PROFILE --probe` and
   verify an actual invocation receipt. Enable capture only after reviewing its scope and retained
   data. Keep both sets of hooks from running as competing writers during cutover.
8. For rollback, stop new writers, export/back up the new store and preserve its post-cutover
   records. `uninstall --profile PROFILE --host HOST` removes only owned groups. Restore the
   prior host settings/installation and original source backup as appropriate. Rehearse a portable
   archive restore into another fresh store before trusting it. Reconcile new records explicitly;
   restoring an older backup alone discards later work. Clear unused recall/index buckets under
   the private retention policy. No personal cutover is performed by these synthetic checks.

See the [Qwen and Codex qualification results](validation/semantic-qualification.md) for cold latency, remaining retrieval failures and native acceptance.
