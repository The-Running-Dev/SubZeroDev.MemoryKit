# MemoryKit architecture

MemoryKit separates durable memory semantics from consumers and optional model runtimes.
SDK, CLI, HTTP and MCP expose the same authorized memory service. SQLite owns current
records, links, indexes, operation outcomes and the history outbox. History providers
implement revision retention; Git is the default, with memory and none also available.

```text
Claude/Codex transcript hooks       Any application/model
              |                     SDK / CLI / HTTP / MCP
              +----------------------------+
                                           |
                            portable application workflows
                            capture / context / accept / import
                               |                      |
                      authorized MemoryClient     optional ports
                               |             Distiller / EmbeddingProvider
                           MemoryService              |
                    validation + authorization   trusted command adapter
                    lifecycle + revision checks  e.g. local Ollama example
                         /                \
                StorageProvider        HistoryProvider
                   SQLite             Git / memory / none
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
semantic expansion scans authorized candidates and holds vectors only in memory. Corrections
and acceptance use the existing optimistic revision model. Import is planned/validated before
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
