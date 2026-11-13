# Notes import: the first Git source, run as an owner cutover

Owner-requested plan, 2026-11-13. S27–S29 are built and merged, so nothing here is a code
slice. This is the runbook for pointing the Git source at the owner's private Notes repository
(`The-Running-Dev/Notes`, local clone `D:\Dropbox\Notes`, branch `main`) and recalling its
notes in any host. [45-git-memory-sources](45-git-memory-sources.md) holds the contract.

## What the repository holds (from `git ls-tree`, no content read)

| Part                        | Files | Plan                                                          |
| --------------------------- | ----: | ------------------------------------------------------------- |
| `Journal/`                  |   284 | Excluded. Private personal material.                          |
| `**/raw/` transcripts       |   106 | Excluded at first. Verbatim, up to 570 KB, and the noisiest.  |
| `SubZeroDev.*` project dirs |  ~150 | Included. One namespace per project folder.                   |
| `Stoic`, `General`, `Notes` |    25 | Owner decides (see Decisions).                                |
| `.json`                     |   135 | Skipped by file type and counted.                             |
| `.md` and `.txt`            |   364 | The candidate set, before the excludes above. 313 md, 51 txt. |

`SubZeroDev.Journal` (30 files) is a project folder, not the private `Journal/`. Its name
makes it ambiguous, so it needs an explicit owner decision.

## Decisions only the owner can make

1. **Consent.** The `/note` skill says a save does not authorize ingestion. Name the folders
   that may be read. Everything else is excluded.
2. **`raw/` transcripts.** Out by default. They duplicate the organized write-up and companion
   brief, and their size splits them into many sections.
3. **Namespace per project.** Proposed: first path segment `SubZeroDev.MemoryKit` maps to
   `project/subzerodev/memorykit`, and so on. Unmapped folders are skipped and reported.
4. **`status`.** `candidate` (default): every note is reviewed once and re-queued when it
   changes. `accepted` skips review. Recommended: `candidate` for the first sync.
5. **`auto`.** Off until the first sync has been reviewed.

## Runbook

1. **Prerequisite.** This host has no MemoryKit profile, store or installed `memorykit`
   command. Run from a built checkout of this repository, or install it first. Installing
   globally is the separate cutover that stays out of scope.
2. **Write the profile.** One `sources[]` entry: `repository` `D:/Dropbox/Notes`, `ref`
   `main`, explicit `include` of the chosen folders, `exclude` `["Journal/**", "**/raw/**"]`,
   a `first-segment` namespace map, `status` `candidate`, no `auto`.
3. **`memorykit source plan`.** Read the counts. Check that `Journal/` and `raw/` appear only
   as counts, that no file is skipped for a secret rule without a reason you accept, and that
   the unmapped count matches the folders you left out.
4. **`memorykit source sync`, once.** It reads committed objects only and writes nothing to
   the repository. No model is needed.
5. **Verify recall.** Ask five questions with known answers, one per project, through
   `retrieve`, and one question no note answers. Each answer must cite its note path and
   commit, and the no-answer question must return nothing.
6. **Review the candidates.** Accept, correct or archive. A correction made through `update`
   is kept when its file changes later, and reported as a `conflict`.
7. **Turn on `auto`** and reinstall the host hooks, so each new `/note` commit is synced by the
   bounded SessionStart check.

## Behaviour to expect

- Recall is S17 lexical `retrieve`, and S31 showed no local source finds everything the
  expansion call does. A paraphrased question can miss a note that shares no words with it.
- Daily automatic recall stays opt-in: S26's cold p95 is above 10 s on this host
  ([decision](90-decisions.md), 2026-11-13). A synced source does not change that.
- Each `/note` save adds three files in one commit, so one save becomes three records. They
  are not deduplicated (out of scope in 45).

## Rollback

Remove `auto` or the source from the profile and reinstall the hooks. Records stay as
candidates; archive them by key prefix `git:notes:`. The Notes repository is never modified,
so there is nothing to undo there.

## Limits

No new code, tests or slice ids. Relative links between the three files of a save are not
turned into memory links, and `raw/` import needs its own decision after step 5.
