# Bounded browse validation

Measured on 2026-11-09, Windows x64, Node 26.12.1, Intel Core i7-11850H.
Synthetic local stores used history `none`, 20 accepted attributed notes in one
exact namespace, default limit 20, default 8,192-byte budget and no previews.
Five sequential calls ran after seeding; these are warm local measurements under
concurrent test load, not remote-network or cold-start qualification.

| Storage | Five call durations (ms) | Median (ms) | Search calls per page | Current-record gets per page | Returned | Compact JSON bytes |
| --- | --- | --- | --- | --- | --- | --- |
| SQLite | 9.01, 6.03, 6.13, 5.97, 6.13 | 6.13 | 20 | 20 | 20 | 4,632 |
| Markdown | 286.82, 294.85, 270.77, 273.38, 281.91 | 281.91 | 20 | 20 | 20 | 4,632 |

Counts were observed by wrapping the public client's `search` and `get` calls.
This correctness-first composition traverses one scoped search result at a time
and revalidates each eligible record. It reduces caller exposure, not backend
reads: a remote SDK composition can incur both network calls per eligible item.
Use the server-side HTTP or MCP browse operation to compose those calls near the
store. Neither this measurement nor byte counts establish token or billing savings.
Filtered navigation can examine up to 200 search pages per request; it reports a
partial page and continuation rather than scanning indefinitely.

Automated coverage in `tests/browse.test.ts` verifies SQLite and Markdown scope
isolation, candidate opt-in, lifecycle eligibility, allowlisted attribution,
literal Unicode filters, pagination, cursor binding, exact UTF-8 envelope bytes,
unconsumed overflow retry, the 200-page scan bound and current-record changes.
The CLI runs in separate processes for continuation tests; HTTP results are
compared with the SDK. `tests/mcp.test.ts` exercises stdio `memory_browse`.

The existing retrieval evaluation ran with `--filler 0,10000`: all hard safety
thresholds passed, including the large-content bound. With 10,000 filler notes,
search p95 was 7.072 ms, retrieve p95 was 34.555 ms and cold-start p95 was 34.506 ms.
Response p95 was 5,265 bytes for search and 5,429 bytes for retrieve; large-content
retrieve used 1,157 bytes. These met their existing limits.

Quality targets still missed: search recall@10 0.735 (target 0.90), paraphrase
recall@10 0 (target 0.70), MRR 0.691 (target 0.75), and retrieve no-answer return
rate 0.500 (target at most 0.20) for both fitted and held-out queries. Browse adds
navigation, not a change to ranked retrieval quality. No real model/provider
qualification was run for this change.
