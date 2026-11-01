# Portable memory

One store can serve unrelated projects, different models and conventional applications.
The portable workflow uses the existing authorized service, with no required model or
second database. The package remains unpublished. Node 22.18 or later is required.

## Install and connect hosts

```bash
npm ci
npm pack
npm install -g ./subzerodev-memorykit-0.1.0.tgz
memorykit setup --store /absolute/path/store --output /absolute/path/config --capture --include-candidates
```

Windows paths such as `D:/MemoryKit/store` work too. Quote paths containing spaces.
Keep configuration outside untrusted repositories. Setup initializes a missing store and
writes a profile, Claude/Codex hook fragments, common JSON MCP fragment and instructions.
It refuses to overwrite generated files and does not change existing host settings.

Merge Claude event groups into `~/.claude/settings.json`, Codex groups into `~/.codex/hooks.json`,
preserving existing groups. In Codex, review and trust hooks through `/hooks`. Adapt the
MCP fragment to your host's server configuration. Remove the added groups/server to
uninstall. Regenerate fragments after moving the installed package. Claude uses executable
plus arguments; Codex uses a quoted command string.

Capture is off unless `--capture` is present. Context includes accepted records only unless
`--include-candidates` is present. Both flags give automatic, visibly unverified observations
between sessions. For curated memory, capture candidates and accept selected records later.
Profile booleans `capture`, `context` and `includeCandidates` are independent.
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
SDK exports: `capture(client,input,distiller?)`, `context(client,input,embedding?)`,
`accept(client,id,expectedRevision)`, `planClaudeMemImport` and `importClaudeMem`.
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

## Capture, review and correction

SessionStart injects context through `additionalContext`. Stop and PreCompact capture text
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

No model is required. Implement SDK `Distiller`/`EmbeddingProvider`, or configure a trusted
executable and argument array in a CLI profile. `subzerodev-memorykit/providers-command`
runs without a shell and exchanges one JSON request/response through stdin/stdout. Commands
inherit the environment; do not let untrusted repositories supply profile commands.

- Distillation request: `{version:1,task:"distill",input:<CaptureInput>}`; response:
  `{observations:[{id,role,content,kind?,evidence?}]}`. Empty means nothing durable. Output is
  validated before writes and forced to generated/candidate status; it cannot widen scope.
- Embedding request: `{version:1,task:"embed",role:"query"|"document",texts:[...]}`; response:
  `{vectors:[[...],...]}`. Finite, consistently dimensioned vectors must share a compatible space.

Distillers should return stable IDs/content for identical inputs. Changed output conflicts
instead of replacing prior memory. Host distillation hashes the selected transcript snapshot
as event identity; later snapshots can add repeated information. This is not semantic
deduplication or incremental extraction.

Document embeddings are batched by 32 and clipped to 8192 code points with visible omission
reporting. Vectors are ephemeral; purge leaves no persistent vector copy. Providers receive
selected authorized content, so choose endpoints consistent with your privacy requirements.
Each command defaults to 30 seconds (maximum 120), input 8 MiB, output 4 MiB (maximum 16).
Multiple batches have separate timeouts. Failures are explicit; provider diagnostics are
suppressed because prompts/output can be private.

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

The example defaults to loopback; `--url` explicitly chooses another endpoint. It uses
documented Ollama [chat](https://docs.ollama.com/api/chat) and
[embedding](https://docs.ollama.com/api/embed) APIs, preserves original message roles and
fails instead of silently truncating model inputs. Other runtimes implement the same protocol.

Semantic expansion is experimental and opt-in. It combines lexical and positive-cosine
semantic ranks with reciprocal-rank fusion (k=60); it does not guarantee answerability.
S18/S21 quality/cost gates remain failed. Synthetic tests prove integration/isolation, not
real-world relevance. Lexical retrieval remains the default. A recommended model, measured
answerability, persistent vector indexing and further automatic host adapters remain follow-up work.
