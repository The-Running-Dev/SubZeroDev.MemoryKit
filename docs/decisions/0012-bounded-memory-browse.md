# ADR-0012: Bounded browsing of attributed memory summaries

Status: Accepted, 2026-11-03.

Expose `browse(client, input)` as a portable workflow composed from authorized
`search` and `get`. Keep MemoryClient and StorageProvider unchanged. CLI `browse`,
HTTP `POST /v1/browse` and MCP `memory_browse` call the same implementation.

Browse exact namespaces, newest first, with active, accepted, unsuperseded records
by default. Candidates require an explicit per-request opt-in for navigation.
Project only allowlisted identity, revision, attribution and size fields. Optional
previews are deterministic excerpts of original content, never generated summaries.
Browsing does not accept records, capture observations or inject context. A caller
fetching a selected record for context must recheck revision, scope and eligibility.

Use scoped no-text storage search, then an NFC-normalized, case-insensitive literal
content substring filter. Existing full-text retrieval ranks a wider corpus before
authorization in some providers; using it here could let hidden namespaces change
page boundaries. Browse deliberately provides navigation rather than relevance
ranking. Scan at most 200 scoped search pages of one record, validating each selected
record against a current authorized get before projection.

Bound the entire compact JSON result, including continuation and byte counter.
Reserve stopping-reason overhead before adding a record; an oversized next item
remains unconsumed. A small budget may return an empty partial page; retry with a
larger maxBytes. If the continuation alone exceeds the budget, fail explicitly.
Never expose totals or facets over another scope. Partial reasons distinguish
item, byte and scan budgets, provider partial results and concurrently changed records.

Cursors bind normalized scope, filters, preview policy and authorization identity.
Built-in clients supply stable internal identities; arbitrary third-party clients
are bound to their instance. No identity method is added to the public client.
Cursors are opaque navigation state, not credentials or signed capabilities; every
search/get still authorizes current access. Limit and byte budget may change while
resuming. Pagination is a live view, not a snapshot, and concurrent writes can change
what appears between pages. Server-side and remote SDK helper cursors have different
identity contexts and should be resumed through the interface that created them.
