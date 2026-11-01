# ADR-0002: Portable capture and context above the authorized client

Status: Accepted for this implementation, 2026-11-01.

The owner clarified that MemoryKit must work across projects and LLMs, including replacing
a host-specific memory tool, and authorized closing the capture/context gap. The core already
had durable records, scopes, history and transports; the end-user workflow remained consumer-specific.

Add workflows over `MemoryClient`, shared by SDK/CLI/HTTP/MCP. Keep transcript parsing and
model execution in adapters. Reuse namespaces, metadata, provenance, idempotency, authorization
and lifecycle, without changing storage schema or making workflow conventions mandatory core rules.
Project/shared scope stays explicit. Capture/import create attributed candidates. Accepted-only
context is the default; recalling candidates is an explicit option, not factual endorsement.

Generate reviewable Claude/Codex fragments without editing global settings. Capture is opt-in.
Bound source/context, expose omissions and partial failures, preserve later curation on retries,
and import claude-mem with explicit ownership and stable source installation identities.

Learning and embeddings are optional ports. A trusted command adapter supports model runtimes
without a mandatory SDK; a working optional Ollama example ships separately from the core.
Explicit semantic opt-in scans authorized candidates with ephemeral vectors. This extends the
former product-code deferral only for an experimental provider surface under the renewed scope;
it does not endorse a default backend, pass the failed S18/S21 gates or revive retired S19/S20.

Trade-offs: bounded recent selection is not a whole-corpus scan; command models add latency
and need stable output for reproducible retries; distilled snapshots can repeat information;
MCP still needs host-specific registration. Universal automatic lifecycle integration, unattended
acceptance, vector indexing and answerability are not promised.
