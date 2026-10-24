# Brief — SubZeroDev.MemoryKit

> The problem, the non-goals and the definition of done are mine. A model may interrogate this
> file (`/brief`) or type it from my answers (`/interview`). It may not originate it from an idea.

Source: *MemoryKit — Initial Requirements & Architecture Seed*, v0.1, supplied 2026-10-25. Everything outside `## Assumptions and open questions` is stated in that document.

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
9. **Ports and adapters.** Adapters (SDK, CLI, MCP, later others) expose one core; the MCP server is an adapter, never a second memory implementation.
10. **Memory is data, not authority.** Stored or generated memory is never a privileged instruction. A learning provider proposes candidates; it never overrides application policy or established facts. Consumers (e.g. AgentKit changing its own rules) keep that authority.
11. **History is not validity.** The system distinguishes what was believed at a time, a later correction, a superseded memory, the current accepted interpretation, and a past event that remains true.
12. **Retrieval relevance is not factual correctness**, and more retrieved information is not assumed better: bounded, on-demand retrieval of the minimum useful information.

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
- SDK, CLI and MCP server over the same core;
- one small test implementation of a provider interface, proving replaceability.

The first milestone is persistence and retrieval through the SDK and CLI; the rest builds on it.

## Environment
- **Platform:** portable; no OS-specific deployment model. The owner's host is Windows.
- **Install footprint:** a basic installation needs no hosted database, vector database, graph server, LLM API, always-running daemon or cloud account. An optional provider may need more.
- **Online/offline:** retrieval works without a model or a network connection.
- **Reliability:** failures are reported explicitly; the platform never silently loses memory, claims a revision that was not persisted, or returns incomplete results as complete.
- **Security baseline:** namespace isolation, authorisation, input validation, provider trust boundaries, safe handling of retrieved content, secret detection where applicable, retention, deletion semantics, concurrent access, recovery. Removing a record from current storage may not remove it from history or remote copies; the v1 contract documents and correctly represents that.
- **Performance:** measurable baselines for create, exact retrieval, search latency, revision retrieval, growth, index maintenance and resource use. No targets are invented before the first implementation is measured.
- **Observability:** which provider performed an operation, whether it succeeded, whether results were complete, which revision was returned, why it failed — without logging memory contents or sensitive data.
- **Content:** not required to be natural language; v1 may support UTF-8 text and structured data, with room for binary or media references later.
- **Process:** built with AgentKit. Preserve established decisions; small verifiable slices; running code over speculative review; proportional, bounded review; record meaningful decisions.

## Lifespan
Assumed: maintained for years, as standalone distributable open-source infrastructure (see below).

## Assumptions and open questions
- Assumed: lifespan is long-term maintained, read from "standalone, distributable project" and "independent open-source infrastructure".
- Assumed: v1 is single-machine and local-first; synchronisation between installations is out of v1 (distributed sync is deferred).
- Assumed: A5's two agents may be separate processes on the same machine using the same memory location at the same time, so v1 needs defined behaviour for concurrent writers across processes — without a daemon.
- Assumed: "illustrative" interfaces and record shapes in the seed (§4.1, §5) are inputs to `/design`, not contracts.
- Scrutiny — authorisation without a daemon: with no always-running service, every consumer reads the store with its own operating-system permissions, so any process that can read the files can bypass an in-process authorisation check. v1 authorisation can therefore only be enforced at the API boundary for cooperating callers, with real isolation coming from the operating system (separate locations and file permissions). Recommended: the v1 security contract states this plainly; a daemon or service adapter is what later adds enforced authorisation. Affects A12.
- Scrutiny — permanent deletion under Git: removing data from Git history needs history rewriting, and no local operation can guarantee removal from clones or remotes already holding it. Recommended: v1 distinguishes tombstone (current state), and purge (local history rewrite, reported as not covering remote copies). Affects A12 and D12.
- Open, for `/design` (each named in the seed's decision backlog; none blocks starting `/design`):
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
