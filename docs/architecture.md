# MemoryKit architecture

MemoryKit separates durable memory semantics from consumers and optional model runtimes.
SDK, CLI, HTTP and MCP expose the same authorized memory service. The selected storage
provider owns current records, links, indexes, operation outcomes and the history outbox.
Built-ins are SQLite and managed Markdown; explicitly configured external modules implement
the same public contract and token-store lifecycle. History providers
implement revision retention; Git is the default, with memory and none also available.

```text
Claude/Codex transcript hooks       Any application/model
              |                     SDK / CLI / HTTP / MCP
              +----------------------------+
                                           |
                            portable application workflows
                            capture / context / review / import / reconcile
                               |                      |
                      authorized MemoryClient     optional ports
                               |             Distiller / EmbeddingProvider / RecallSelector
                           MemoryService              |
                    validation + authorization   trusted command adapter
                    lifecycle + revision checks  e.g. local Ollama example
                         /                \
                StorageProvider        HistoryProvider
             SQLite / Markdown / plugin   Git / memory / none
```

The workflow layer imports domain types and the authorized client contract only. It never
opens stores, discovers private sources, launches models or grants access. Host adapters
parse bounded transcript text and prompt events. Default native recall queries at prompt
submission; startup recency requires explicit opt-in. CLI selects configuration, connections and optional
providers. HTTP/MCP invoke workflows without request-selected executables. Conventional
applications use the raw memory service without any capture/model dependency.

Capture validates a full batch, derives stable operation identities, writes attributed
candidates and reports per-item failures. Context selects exact project/shared namespaces,
filters lifecycle and acceptance, and renders a UTF-8-bounded data envelope. Optional
semantic expansion scans authorized candidates and holds vectors in memory unless an optional
EmbeddingIndex is supplied. The SQLite cache is derived infrastructure, separate from storage
plugins and retained history. Optional
extractive task selection uses bounded authorized passages; provider abstention
does not fall back to recent or lexical context. Selected revisions are checked again before output.
Task discovery searches the full authorized lexical index using bounded task terms and optional
query-only expansion before passage selection. Long passages use a query-centered window.
Discovery preserves scope/eligibility and reports bounded omissions; it is not a semantic index.
Corrections and acceptance use the existing optimistic revision model. Import is planned/validated before
writes, then reuses capture rather than bypassing lifecycle semantics.

Authentication belongs to the server boundary. Namespace grants are enforced by the service;
scope selection is not authorization. Embedded access intentionally has full authority.
Remote service access uses the existing token/OIDC and TLS mechanisms. Captured provenance
is asserted data, not authenticated identity. Retrieved content is untrusted evidence, not
privileged instructions. Context is not a transactional snapshot of concurrent writes.

Default retrieval remains lexical. Optional model ports do not alter the failed S18/S21
quality gates or claim answerability. See [portable memory](portable-memory.md) for usage
and limits, [the contract](../design/20-contract.md) for semantics, and
[ADR-0002](decisions/0002-portable-memory-workflows.md) for the extension decision.
Task-aware host timing and upgrade behavior are recorded in
[ADR-0003](decisions/0003-task-aware-host-recall.md).
Optional provider-neutral selection and native Codex acceptance are recorded in
[ADR-0004](decisions/0004-evidence-based-recall-selection.md).
Storage composition, query discovery and upgrade behavior are recorded in
[ADR-0005](decisions/0005-portable-storage-and-discovery.md).
Portable archives/PostgreSQL are recorded in [ADR-0006](decisions/0006-verified-portable-memory.md).
Managed installation, review and derived caches are recorded in
[ADR-0007](decisions/0007-managed-memory-replacement.md).

Optional exact provider-call reuse, public plugin conformance and remote review are recorded
in [ADR-0008](decisions/0008-practical-daily-memory.md). The opt-in recall cache contains
sensitive queries/quotes and never bypasses final current-record validation.

Recall now has a total deadline and configurable passage/byte budgets across expansion,
selection and verification. Command adapters receive cancellation; model examples use compact
passage indices and map them back to supplied identities and exact text. Optional verification,
current revision checks and abstention remain independent requirements.

PostgreSQL maintains transactional, derived search rows beside its authoritative JSONB snapshot.
Managed Markdown can opt into a rebuildable SQLite term index and reads candidate files against
their manifest hashes. These indexes narrow reads; store opening, writes and unfiltered scans
can still be linear. Provider probes and replacement-readiness assessment are explicit diagnostic
operations. Their local evidence does not switch hosts or enable capture. See
[ADR-0009](decisions/0009-bounded-recall-and-indexed-readiness.md). See [ADR-0010](decisions/0010-semantic-cold-recall.md) for model prompt and cold latency qualification.
