# S31 — Local candidates against the expansion call

Synthetic evidence; qualifies nothing. Generated 2026-11-13T14:12:05.416Z by `scripts/measure-local-candidates.ts`. No provider was called.

## Method

- Store: the S26 corpus and held-out cases (58 supported), the bicycle, deep-passage and injection records, and 1000 newer fillers.
- Expansion arm: the queries recorded in `docs/validation/bounded-codex-final.json` (codex-gpt-6.1-sol-verified, 2026-11-02T19:55:58.552Z) replayed through the real `discover` (bound 200, 32 slots). `dup-timeout` has no recorded queries and gets none. The provider byte budget can cut the set further, so expansion is credited generously.
- Local sources, no model call: S17 lexical without expansion, MiniLM vectors (Xenova/all-MiniLM-L6-v2, revision 751bff37, fp32) over the whole eligible scope, and RRF of the two (pool 50).
- Score: a case loses a record when expansion found a needed record and the source did not.

## Result (58 cases, 49 with a needed record; expansion missed none)

| Source @ depth | Cases with a needed record | Lost records | Cases that lose                                  | Mean candidates |
| -------------- | -------------------------- | ------------ | ------------------------------------------------ | --------------- |
| lexical @ 16   | 49                         | 3            | para-token-lifetime, old-paraphrase, old-verbose | 10.4            |
| vector @ 16    | 49                         | 2            | old-verbose, deep-passage                        | 16.0            |
| rrf @ 16       | 49                         | 1            | old-verbose                                      | 16.0            |
| lexical @ 24   | 49                         | 2            | old-paraphrase, old-verbose                      | 15.1            |
| vector @ 24    | 49                         | 2            | old-verbose, deep-passage                        | 23.9            |
| rrf @ 24       | 49                         | 1            | old-verbose                                      | 23.9            |
| lexical @ 32   | 49                         | 2            | old-paraphrase, old-verbose                      | 16.5            |
| vector @ 32    | 49                         | 2            | old-verbose, deep-passage                        | 31.5            |
| rrf @ 32       | 49                         | 1            | old-verbose                                      | 31.5            |
| lexical @ 50   | 49                         | 2            | old-paraphrase, old-verbose                      | 16.5            |
| vector @ 50    | 49                         | 2            | old-verbose, deep-passage                        | 48.6            |
| rrf @ 50       | 49                         | 1            | old-verbose                                      | 48.6            |

`old-verbose` ("Please review the equipment inventory, write tests, update the documentation and tell me where my cycling equipment is kept.") is lost by every source and depth. Its needed record says "bicycle"; only the expansion queries (bicycle, helmet, pump, lock, cycling, equipment) contain that word. S31.2 therefore fails and expansion stays.

## Cost and limits

- Embedding: model load 355 ms, query p95 3.9 ms, document p95 3.3 ms, 1071 documents.
- Host: win32 10.0.26200, 16 CPUs, 32 GiB, Node v26.12.1.
- Expansion candidates are the first 32 discover() results from the recorded queries; the provider byte budget can cut that set further, so expansion is credited generously.
- Local sources rank the whole eligible scope; context() scans only the newest 200 records.
- Oracle selection admits only needed records, so it cannot admit an irrelevant one; irrelevant counts show what a selector would have to reject.
- The expansion queries are from Codex `gpt-6.1-sol`, not the resident Qwen path S30 kept.
- Skipped as unsupported by this harness: 10 of the corpus queries.

Raw rows: [s31-local-candidates.json](s31-local-candidates.json).
