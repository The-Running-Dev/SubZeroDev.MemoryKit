# ADR-0009: Bounded recall, derived candidate indexes and local readiness evidence

Status: Accepted for this implementation, 2026-11-02.

Use one total context deadline (60 seconds by default, configurable up to 120 seconds), across
discovery, selection, verification and retries. Cancellation reaches command providers, kills
their process trees on Windows and their isolated process groups on POSIX, and prevents later
provider phases. Storage operations and arbitrary SDK providers may not support cancellation;
the response deadline does not promise their immediate termination. Per-command limits remain
independent and retries never restart the total clock.

Expose bounded passage count, passage length and serialized input bytes on the selector/profile.
The two shipped model adapters privately request passage indices, then restore identities,
revisions and exact supplied passage text. The public extractive protocol and final workflow
validation remain unchanged. Full bounded passages can carry more incidental text than a short
quote; output byte limits still apply. A verifier can only retain proposed passages. Prompt
examples describe general category membership and false-premise corrections, not corpus answers.
Generated aliases are individually searched as well as phrases because providers differ in
conjunctive retrieval semantics. Scope and acceptance are decided outside the model.

Keep durable state authoritative. PostgreSQL candidate rows and the version marker commit with
the JSONB snapshot under the existing store lock; repeatable reads prevent mixing generations.
An older writer dropping the marker triggers authoritative fallback. Markdown indexes retain
terms and metadata, load verified candidate files, and are invalidated before a current writer
publishes a manifest. Missing/corrupt derived indexes rebuild; authoritative corruption still
fails. Opening and writes remain linear. Derived indexes are sensitive and logical purge is
not physical erasure. Indexes do not change lexical ranking or the public plugin contract.

Doctor performs model calls only with an explicit provider probe. Readiness consumes local
synthetic attestations, hashes normalized provider configuration without publishing command
arguments, and requires complete quality, cold latency, both native hosts, migration/rollback,
provider health and current local installation. Reports are not signed proofs. Fingerprints
do not bind a package build or changes behind a stable executable/model ID: retain candidate
digests and update IDs when adapters/models change. A failed local-model gate remains failed.
