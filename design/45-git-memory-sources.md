# S27–S29 — Git repositories as memory sources

Owner-requested plan, 2026-11-10. A Git repository of Markdown or text documents becomes a
read-only source of memories that stay in step with its commits. The first intended source is
the owner's private Notes repository, written by the `/note` skill. Nothing here is specific to
Notes: design docs, ADRs, runbooks or a wiki checked into any repository use the same path.

## How the motivating source is written

`/note` commits straight to `main`, one commit per save, with a conventional message
(`note(<Project>): <title>`). Each save adds three files under a project folder: an organized
write-up, a companion brief or usage note, and a verbatim conversation transcript under `raw/`.
Every file has YAML front matter (`title`, `project`, `date`, `type`, `tags`,
`source-coverage`, `record-kind`, `visibility`), and the three files link to each other
with relative links. It also maintains a root `INDEX.md`. At planning time the repository held
307 Markdown files, 135 JSON and 51 text files, with 30 to 40 commits on busy days. Transcripts
reach 570 KB, which is over the 256 KiB `maxContentBytes` default. A `Journal` folder
holds private personal material. The skill says a save "does not authorize memory/graph
ingestion", so ingestion needs its own explicit, path-scoped consent.

## Outcome

A person names a repository, a branch and the paths to read, and decides where they land.
MemoryKit then keeps one memory per document, or per section of a large document. It updates
or archives each one as later commits change, rename or delete the document. Any host recalls
them through the existing `retrieve`, `browse` and `context`, without new retrieval code. The
repository is never written. Running the sync needs no model.

## Contract

- **Source configuration.** It lives in the profile, under `sources[]`:
  - `id`: lowercase, stable and unique per store.
  - `repository`: an absolute path to a local clone.
  - `ref`: an explicit branch or ref; it is required, and there is no `HEAD` default.
  - `include`: required and nonempty.
  - `exclude`.
  - `namespace`: a fixed namespace, or a mapping from a front-matter field or the first path
    segment to exact namespaces.
  - `status`: `candidate` (the default) or `accepted`.
  - `chunkBytes`: the default is 32768, and the maximum is `maxContentBytes`.
  - `fetch`: optional, and off by default. It names a remote to fetch before syncing.
  - `auto`: off by default.

  A path or mapping value that matches nothing is skipped and counted, never sent to a
  fallback. HTTP and MCP can name only configured source ids, never a path or a ref.

- **Read path.** Only committed objects are read: `rev-parse`, `ls-tree -r -z`,
  `cat-file --batch` without filters, and `diff-tree -r -z -M`. MemoryKit never checks out,
  writes, runs repository hooks, or applies textconv or filter drivers. Uncommitted edits are
  invisible. The default file types are `.md`, `.markdown` and `.txt`; other files are skipped
  and counted.
- **Parsing.** Front matter is read with a bounded YAML subset: scalars, quoted strings, flow
  and block lists, and one level of maps. No new runtime dependency is added. Unsupported front
  matter stays in the content and is reported. Allowlisted fields (`title`, `date`, `type`,
  `tags`, `project`, `record-kind`) are copied to `metadata.frontmatter`. `kind` comes from a
  per-source map of `type` values, with `document` as the default. Content is the document text
  without the front matter.
- **Records.**
  - **Key.** It is `git:<sourceId>:<path>`, or `git:<sourceId>:<path>#<ordinal>-<heading-slug>`
    for a section.
  - **`metadata.source`.** It holds `{kind:'git', id, commit, path, blob, section,
contentSha256}` and the commit author and time.
  - **Provenance.** `provenance.origin` is `{kind:'git-source', name:id, version:commit}`, with
    one evidence ref, `git:<sourceId>@<commit>:<path>`.
  - **`sourceRole`.** It is left unset, so attribution reads as unknown. A document is neither a
    user turn nor generated output, and a transcript inside it keeps its own labels.
- **Chunking.**
  - A document up to `chunkBytes` is one record.
  - A longer document is split at its highest heading level that yields sections within the
    limit, and then at paragraphs.
  - A document over 4 MiB, or over 256 sections, is skipped and reported.
- **Identity of writes.** An operation id is derived from the source id, the commit, the path
  and the section, so an interrupted sync resumes by exact replay.
- **Secret guard.** These paths are excluded by default: `.env*`, `*.pem`, `*.key`, `id_*`,
  `*.p12` and `*.pfx`. A document containing a private-key block, or a high-confidence token
  prefix, is skipped and reported by path and rule, and is never stored. The skill already
  redacts, and this is a second guard, not a scanner.

## Sync rules

| Repository change                                         | Memory outcome                                                                                                   |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| New included file                                         | Create at the source's status                                                                                    |
| Changed blob, record content still equals `contentSha256` | Update with `expectedRevision`. A `candidate` source resets status to candidate, so the change is reviewed again |
| Changed blob, record content edited locally               | Leave it, and report `conflict`. Never overwrite a correction                                                    |
| Rename (`-M`)                                             | Create under the new key, then supersede the old record with it                                                  |
| Deleted, or no longer included                            | Archive. Purging stays a separate owner action                                                                   |
| Section split changes                                     | Match by heading slug, then by ordinal. Archive unmatched old sections                                           |
| Cursor commit unreachable (force push or rebase)          | Full tree reconciliation against the records' blob ids                                                           |

The source-to-store truth is the records' own `metadata.source`. The cursor is a per-store
state file beside the profile, holding the last fully applied commit for each source. It is
an optimization: losing it costs a full reconciliation and does not risk duplicates.

Bounds per sync:

- at most 2,000 changed paths;
- 64 MiB of blobs read;
- a deadline.

When a bound stops the sync, it reports `partial`, keeps the old cursor and replays next time.

## Slices

S27, S28 and S29 are in [30-slices](30-slices.md), in that order. Each depends on the one
before it.

## Limits

This plan does not cover:

- reading uncommitted work;
- non-text formats;
- writing back to the repository;
- accepting records automatically, beyond a source the owner configures as `accepted`;
- turning relative links into memory links (a later slice);
- semantic deduplication across the three files of a note save;
- any change to retrieval ranking or the failed S18/S21 gates.

Ingesting the owner's own Notes repository is an owner cutover step after S29. It is not part
of any slice, and the tests use synthetic fixtures only. The S26 cold-latency blocker still
governs daily automatic recall. Syncing a source does not lift it.
