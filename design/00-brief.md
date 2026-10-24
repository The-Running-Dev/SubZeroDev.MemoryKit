# Brief — SubZeroDev.MemoryKit

> The problem, the non-goals and the definition of done are mine. A model may interrogate this
> file (`/brief`) or type it from my answers (`/interview`). It may not originate it from an idea.

Sources: *MemoryKit — Initial Requirements & Architecture Seed*, v0.1, and *Design Checkpoint Handoff: Remote Access, Authorization, History and Premises*, both supplied 2026-10-25. Where they differ, the handoff wins. Everything outside `## Assumptions and open questions` is stated in one of them.

## Problem
Software that needs persistent, contextual memory has no reusable way to get it. MemoryKit is a general-purpose memory platform that separates what memory means — identity, scope, lifecycle, provenance, relationships — from how it is stored, retrieved, versioned, learned from, captured and synchronised. Consumers use one versioned interface; providers behind it are interchangeable.

It started from AI-assisted engineering: agents lose context between sessions, different agents keep incompatible memory, lessons are rediscovered, decisions scatter across files and conversations, agents cannot tell current knowledge from obsolete, and existing memory tools need heavy infrastructure or spend excessive tokens. None of this is specific to AI, so MemoryKit must not assume its consumer is an agent or a model.

The core owns contracts and semantics. Providers implement them. Consumers decide why they need memory and how it becomes authoritative in their domain.

### Established direction (binding; not reopened without new evidence)
1. **Consumer independence.** No inherent dependency on LLMs, AI agents, AgentKit, SkyNetHR, GodComplex, Claude Code, Codex or any domain. A conventional application uses MemoryKit without installing or invoking a model.
2. **Contract first.** MemoryKit owns public contracts and memory semantics; consumers never need a provider's internal structures.
3. **Interchangeable implementations.** Storage, retrieval, history, learning and other substantial mechanisms are replaceable. No database, file format, graph engine or model provider is an unavoidable dependency. The separation is real — no provider assumptions leaking through the core.
4. **Git is the first history provider, behind a history interface it does not define.** A third party can replace it. Git concepts are never mandatory history semantics; revision IDs, commit IDs, timestamps and memory IDs are distinct.
5. **Versioned API that can evolve.** v1 need not anticipate every capability; the public API and provider contracts are explicitly versioned. Compatibility and migration policy are designed but do not block v1.
6. **One implementation per capability for v1.** Prove the platform by using it; expand on observed need.
7. **Automatic capture is a goal, separable from the core.** Applications without lifecycle hooks use explicit APIs.
8. **Standalone open-source infrastructure.** Documented interfaces that others can implement; the core never assumes all providers are maintained by this project.
9. **Ports and adapters.** Adapters (embedded SDK, CLI, HTTP API, MCP, later others) expose one application service over one core; none implements its own business rules, and the MCP server is never a second memory implementation. A write through any adapter produces the same state transition as the equivalent authorized write through any other.
10. **Memory is data, not authority.** Stored or generated memory is never a privileged instruction. A learning provider proposes candidates; it never overrides application policy or established facts. Consumers (e.g. AgentKit changing its own rules) keep that authority.
11. **History is not validity.** The system distinguishes what was believed at a time, a later correction, a superseded memory, the current accepted interpretation, and a past event that remains true.
12. **Retrieval relevance is not factual correctness**, and more retrieved information is not assumed better: bounded, on-demand retrieval of the minimum useful information.

### Deployment modes (v1)
MemoryKit runs in three modes with the same core memory semantics:

| Mode | Description |
|---|---|
| Embedded/local | An application uses MemoryKit directly in its own process. No listener. |
| Local service | Applications talk to a MemoryKit service on the same machine. |
| Remote service | Applications and agents on other machines talk to a MemoryKit service over the network. |

Multi-machine **access** is required in v1: one authoritative memory instance on one machine may serve many remote clients. Multi-node replication, clustering and distributed consensus are not. Remote access is not distributed storage. Embedded operation needs no background service; a remote endpoint necessarily needs a running listener or an equivalent hosting environment.

Two or more clients — separate processes, different agent frameworks, clients on different machines, conventional applications — may use the same memory concurrently, without silent overwrites or corrupted history.

### Interfaces (v1)
- **Embedded SDK** — direct access to the core; no listener.
- **HTTP API** — for applications on the same machine or over the network: versioned contract, authentication for protected operations, authorisation by operation and memory scope, structured errors, bounded requests and responses, optimistic concurrency, transport security for remote connections.
- **MCP server** — the same supported operations for AI agents: local stdio where useful, remote Streamable HTTP, authentication and authorisation for remote connections, on the current official MCP specification supported by the chosen SDK, with protocol-version compatibility accounted for.
- **CLI** — as in the seed.

HTTP status codes and MCP protocol errors need not share a wire format; their domain meaning must match.

### Authorisation
- **Embedded:** a process with direct filesystem access can bypass checks made inside a library. MemoryKit validates logical scopes and operation requirements, the host application owns its execution identity, and the operating system provides isolation. The SDK does not claim to be a security boundary against its own host. Accepted for v1.
- **Service:** the service is the enforcement boundary. It authenticates each request and authorises the operation before any provider is invoked; clients need no access to storage. Run it under an operating-system identity that owns the storage. If untrusted local processes share that identity's filesystem permissions, the bypass remains — documented, not hidden.
- **Concepts:** principal (client identity), memory namespace, ownership or permitted access, operation permissions, authorisation failures. Permissions distinguish at least read, write, delete/tombstone, history access, purge, and administrative/provider operations. Purge and administration are never implied by write.
- **Authentication:** a standard mechanism for the chosen runtime; no custom identity provider. Remote MCP prefers standards-compatible OAuth/OIDC or a supported authentication gateway. No unauthenticated remote writes; deny when identity or authorisation cannot be established; validate token issuer, audience and permissions for JWT/OIDC; TLS for remote access; validate HTTP `Origin` where applicable, particularly for MCP; a caller-supplied agent name is never proof of identity; a request cannot broaden its own scope. A local-only listener may use a different documented authentication profile when properly isolated.
- A permission-filtered query never exposes unauthorised content or metadata. Authorisation is enforced identically across HTTP and MCP.

### Deletion, tombstones and purge
- **Tombstone** (ordinary delete): keeps the stable identifier; marks it deleted in current state; excludes it from ordinary active retrieval; cannot be undone by an outdated concurrent writer; stays inspectable through authorised history; keeps its revisions per the history provider's retention policy. Reversible when authorised.
- **Purge** (privileged, separate): removes content from specified storage and history locations where providers support it, and reports exactly which boundaries were covered — current storage removed, local history removed, remote history not modified, clones or backups outside MemoryKit's control, provider does not support historical purge, partial failure needing an operator. A local purge is never reported as confirmed deletion from unknown copies.
- **Git provider:** supports ordinary revisions and tombstones. An ordinary delete never rewrites shared history; purge never force-pushes as a side effect; destructive historical cleanup needs its own authorisation; remote cleanup and external-clone cleanup are distinct operations; unsupported or incomplete historical removal is reported. v1 may support tombstones and current-state purge while reporting full historical purge as unsupported — the contract is still defined in v1.
- **Retention before history:** the configured retention policy applies before anything enters a history provider. A provider never silently writes content into permanent Git history when its policy forbids it. Encryption protects contents but is not erasure.
- **Provider independence:** deletion semantics belong to MemoryKit's contract; each storage and history provider advertises the deletion and purge capabilities it actually has. Git's limits are not every provider's requirements.

### Adjudicated design premises (2026-10-25)
1. **Storage and history.** Storage owns live persisted state; the history provider records meaningful revisions. Under a history-required policy a write is not fully complete until history is satisfied. If storage succeeds and history fails: return an explicit partial outcome; record a durable pending-history operation holding the record identity, expected revision and operation identity; make recovery safely retryable without duplicate revisions; never report full success. Service start-up or an authorised recovery operation may reconcile. The contract distinguishes storage persisted, history persisted, history pending, operation failed. No distributed transactions for v1.
2. **Concurrent writes.** Optimistic concurrency through expected revisions; the caller names the expected revision; conflicting updates are rejected; no silent last-writer-wins for guarded updates; concurrent creates cannot produce duplicate identities; locking and revision checks hold across processes sharing one store and for remote clients alike. Locks are provider-appropriate and never part of the public API. No distributed multi-node locking in v1.
3. **Lifecycle and relationships.** The core interprets active, superseded, archived and tombstoned, and the `supersedes` relationship. Other relationships (`derived_from`, `contradicts`, `validated_by`, `depends_on`, application-defined) are typed links the core stores without interpreting; a future graph provider may traverse them. No graph processing for ordinary operations. Application metadata stays application-owned; the core validates record structure only.
4. **Provider language.** v1 providers may be in-process, in the core's language. That is an explicit v1 limitation, not an invariant: future providers may run out of process behind a language-neutral protocol. No cross-language provider hosting in v1 unless genuinely necessary; no language-specific types in language-neutral contracts; a versioned external data representation; provider contracts able to evolve.
5. **Adapter consistency.** SDK, CLI, HTTP API and MCP use the same core operations. Under equivalent authorisation and state they return equivalent records, keep stable identities, apply the same lifecycle and concurrency rules, produce equivalent domain errors and order queries consistently. Shared conformance tests cover embedded SDK, CLI, HTTP API, MCP stdio and MCP over HTTP, without duplicating acceptance logic per adapter.
6. **Search.** Exact ID lookup, lexical matching, scope, lifecycle-state and metadata filters, bounded results, deterministic ordering, explicit complete/partial indicators. No mandatory embeddings, vector databases, graph engines or LLM ranking. A query that hits a resource limit reports possibly incomplete results.

### Primary capabilities (v1 and beyond)
- Create, read, revise, supersede, archive, delete or tombstone, restore, and inspect the history of memories.
- Scope memories (application instance, project, user, team, session, domain namespace, shared set), keeping namespace and ownership distinct from authorisation.
- Relate memories (related to, derived from, supersedes, contradicts, validated by, depends on, belongs to), starting from the minimum useful link model.
- Search with bounded results, filters by scope, state and metadata, references back to evidence, and an explicit complete / partial / failed distinction — without a model or a network.
- Record provenance: origin, change reason and evidence where known. Git authorship alone is not evidence of which agent or application originated an observation.
- Discover providers and negotiate capabilities: identity, version, supported contract versions, capabilities, configuration requirements, limitations. Unsupported operations fail predictably or use an explicitly defined fallback, never fabricated behaviour.
- Later, through optional providers: learning (rules, LLMs, pattern detection), capture (hooks, events), synchronisation (Git remote, file sync, custom). Capture, learning, synchronisation and history are separate capabilities.

### Integration scenarios
- **AgentKit** — engineering knowledge, cross-session handoffs, cross-agent retrieval, recorded mistakes and lessons, retrieval before implementation. AgentKit stays an external consumer; MemoryKit does not inherit its workflow.
- **GodComplex** — character memories, world events, relationships, player decisions and consequences, temporal knowledge — without an AI agent, preserving GodComplex's determinism and replay semantics, and never becoming a second source of truth for the world.
- **Standalone CLI client** — proves the core is general-purpose, independent of both.
- Also in view: other AI coding agents, SkyNetHR, websites, desktop and mobile apps, automation, services, third-party applications.

## What we do instead today (and what it costs)
Context is lost between agent sessions; each agent keeps its own incompatible memory; lessons are rediscovered; decisions and observations scatter across files, conversations and tools; existing memory tools can need considerable infrastructure, and graph-based systems can consume excessive tokens and compute.

## Who it is for
Developers integrating memory into their software — first the project owner's own projects (AgentKit, GodComplex, a standalone CLI), then independent developers building consumers or providers against the documented interfaces. Consumers may be conventional applications or AI agents. The project needs no commercial justification; its purpose is engineering experimentation, practical use and reusable infrastructure.

## Non-goals
MemoryKit v1 is not:
- a replacement for Git or for conventional databases;
- a required LLM framework, or a training framework for AI models;
- a new universal knowledge graph;
- a general-purpose agent orchestrator, or a substitute for AgentKit;
- a distributed database or a hosted memory service;
- a complete solution to human or machine cognition;
- a plugin marketplace.

Deferred from the initial release (out of v1 scope):
- full graph memory engine, vector database integration, large-scale semantic indexing;
- multiple production storage backends;
- complex automatic learning, automatic skill generation;
- background observer services;
- distributed synchronisation and conflict-free replication;
- Graphify integration;
- a complex plugin hosting framework built only for hypothetical extensions.

## Definition of done
Acceptance is shown by running behaviour, not by passing unit tests or completed slices. Each scenario is an executable acceptance test.

- **A1 Basic persistence** — an application creates a memory, terminates, restarts, and retrieves the same content and identity.
- **A2 Retrieval** — a search over a collection returns bounded, relevant results with enough metadata to identify their sources.
- **A3 Revision history** — after a memory changes, the history provider exposes both the earlier and the current revision.
- **A4 Provider independence** — a consumer uses the public API without importing implementation-specific storage or Git dependencies.
- **A5 Cross-agent interoperability** — one agent creates a memory through the MCP adapter; another retrieves it through the same platform.
- **A6 Non-AI application** — a conventional application uses the SDK or CLI without loading an LLM, running an MCP client, or installing AgentKit.
- **A7 Failure handling** — a provider failure never produces a false success acknowledgement or an unreported inconsistent state.
- **A8 Revision and concurrency safety** — conflicting updates follow the documented contract rather than silently overwriting.
- **A9 History abstraction** — the core history contract is exercised with a test provider that does not use Git.
- **A10 Integration consistency** — the CLI, programmatic API and MCP adapter produce equivalent results for the same supported operations.
- **A11 Restart and recovery** — an interrupted operation is resumed or reported according to the documented durability contract.
- **A12 Security and privacy** — namespace, authorisation, input validation and historical-retention behaviour satisfy the agreed v1 security contract.

Design scenarios (from the checkpoint handoff; the design must demonstrate each):

- **S-A Local embedded use** — a conventional application creates and retrieves memory without starting a server or using an LLM.
- **S-B Remote API use** — an application on another machine authenticates with a MemoryKit service and performs authorised operations.
- **S-C Remote MCP use** — an AI agent on another machine connects over the supported remote MCP transport and retrieves an authorised memory.
- **S-D Unauthorised access** — a caller attempts another namespace without permission and is denied before the storage provider returns protected information.
- **S-E Concurrent update** — two clients read the same revision; one updates; the second gets a conflict instead of overwriting.
- **S-F History failure** — storage persists an update but Git history fails; the operation reports partial completion, the pending operation survives restart, and recovery does not duplicate revisions.
- **S-G Tombstone** — a logically deleted memory no longer appears as active in ordinary retrieval, while authorised history inspection still works.
- **S-H Purge** — a privileged purge reports exactly which storage and history locations were cleared and which could not be verified or controlled.
- **S-I Non-Git history provider** — a test provider demonstrates the common history contract without importing or executing Git.
- **S-J Cross-adapter consistency** — equivalent authorised requests through SDK, CLI, HTTP and MCP produce consistent state changes and results.

Also: a remote client with valid permissions reaches authorised memory; an unauthorised client cannot read, modify, delete, inspect history of, or purge memory outside its permissions.

And, overall:
- a developer installs it without operating a database or AI service;
- a conventional application creates and retrieves persistent memories;
- a second application or agent accesses that memory through a common interface;
- memory revisions are traceable through the Git history provider;
- applications do not depend on implementation-specific storage details;
- a different provider can satisfy the same contract (a small test provider is enough; a second production backend is not required);
- the system stays understandable and useful without its future advanced capabilities.

## Narrowest useful version
Working memory persistence and retrieval — not an elaborate plugin architecture. The v1 vertical slice:
- core: identity and scope, a common record representation, create / read / update / delete semantics, basic lifecycle, provider contracts, minimal provider registration and configuration, explicit errors and failure behaviour;
- one storage provider (Markdown/filesystem is the leading candidate, not selected);
- one retrieval provider: deterministic lookup and search, no embeddings or model inference;
- one history provider: Git, behind the history interface;
- embedded SDK, CLI, HTTP API and MCP server (stdio and Streamable HTTP) over the same application service and core;
- a service host for local-service and remote-service modes, enforcing authentication and authorisation at its boundary;
- tombstone, and purge with its coverage report (full historical purge may be reported unsupported);
- one small test implementation of a provider interface, proving replaceability.

The first milestone is persistence and retrieval through the SDK and CLI; the rest builds on it. V1 proves the public API and the provider abstraction with a single working backend.

## Environment
- **Platform:** portable; no OS-specific deployment model. The owner's host is Windows.
- **Install footprint:** a basic installation needs no hosted database, vector database, graph server, LLM API or cloud account. Embedded use needs no background service; the local- and remote-service modes run a listener. No infrastructure is added only because remote access is supported. An optional provider may need more.
- **Network:** remote access over TLS; one authoritative instance per store; no replication, clustering or consensus in v1.
- **Online/offline:** retrieval works without a model or a network connection.
- **Reliability:** failures are reported explicitly; the platform never silently loses memory, claims a revision that was not persisted, or returns incomplete results as complete.
- **Security baseline:** namespace isolation, authorisation, input validation, provider trust boundaries, safe handling of retrieved content, secret detection where applicable, retention, deletion semantics, concurrent access, recovery. Removing a record from current storage may not remove it from history or remote copies; the v1 contract documents and correctly represents that.
- **Performance:** measurable baselines for create, exact retrieval, search latency, revision retrieval, growth, index maintenance and resource use. No targets are invented before the first implementation is measured.
- **Observability:** which provider performed an operation, whether it succeeded, whether results were complete, which revision was returned, why it failed — without logging memory contents or sensitive data.
- **Content:** not required to be natural language; v1 may support UTF-8 text and structured data, with room for binary or media references later.
- **Process:** built with AgentKit. Preserve established decisions; small verifiable slices; running code over speculative review; proportional, bounded review; record meaningful decisions.

## Lifespan
Maintained and evolved over years. Public contracts are designed with versioning and provider compatibility in mind; that is not a reason to build hypothetical features in v1.

## Assumptions and open questions
- The seed's TypeScript interfaces and record shapes (§4.1, §5) are illustrative inputs to `/design`. They select no language and define no final API. (Stated in the handoff.)
- Deferred, not to be decided unless they block the first implementation: Markdown versus database storage; one memory repository versus several; cross-language provider runtime; vector and graph retrieval; automatic learning; distributed replication; advanced remote synchronisation; permanent deletion from independently controlled clones; API v2 capabilities. The language is decided at `/design`'s approaches gate, not before.
- Open, from the handoff:
  - History retention profiles — candidates, not API values: full version history, metadata-only history, no persistent content history. Whether v1 supports them.
  - The documented authentication profile for a local-only listener.
  - Which MCP protocol revisions the server answers (the current one, and whether earlier ones too).
- Open, for `/design` (each named in the seed's decision backlog; none blocks starting `/design`; D5, D9, D10 and D12 are now constrained by the sections above):
  - D1 — what one memory is; which distinctions are core and which are application metadata.
  - D2 — mandatory fields; representation of identity, scope, state, content and provenance.
  - D3 — implementation language and runtime, chosen for consumer compatibility, portability, packaging, provider extensibility and existing infrastructure — not because agents are the first consumer.
  - D4 — initial storage provider (Markdown/filesystem, SQLite, other), on simplicity, inspectability, concurrency, durability, portability.
  - D5 — whether Git holds canonical state or records revisions exported by storage, and what happens when one succeeds and the other fails.
  - D6 — memory location: one repository, project-local repositories, or configurable.
  - D7 — initial query contract: mandatory search capabilities, pagination, bounds, relationships, unsupported queries.
  - D8 — smallest discovery and registration mechanism that shows real replaceability.
  - D9 — consistency: revision checks, concurrency, durability, failure recovery.
  - D10 — v1 access model: namespaces, users, applications, agent identities.
  - D11 — whether v1 includes any automatic capture, or it follows once persistence and retrieval are proven.
  - D12 — what can be removed, archived or retained, especially under Git.
  - D13 — minimum export/import or compatibility contract for provider migration.
  - Identity scheme (UUID, ULID, application-supplied).
  - Git: one repository or several, commit granularity, local commits versus remote sync, concurrent writers and merge conflicts, recovery when storage succeeds and history fails.
