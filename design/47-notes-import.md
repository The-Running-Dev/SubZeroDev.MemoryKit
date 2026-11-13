# Notes import: the first Git source, run as an owner cutover

Owner-requested plan, 2026-11-13. S27–S29 are built and merged, so nothing here is a code
slice. This is the runbook for pointing the Git source at the owner's private Notes repository
(`The-Running-Dev/SubZeroDev.Notes`, renamed from `Notes`; local clone `D:\Dropbox\Notes`,
whose `origin` still names the old URL and redirects; branch `main`) and recalling its notes in
any host. [45-git-memory-sources](45-git-memory-sources.md) holds the contract.

## What the repository holds (from `git ls-tree`, no content read)

| Part                        | Files | Plan                                                          |
| --------------------------- | ----: | ------------------------------------------------------------- |
| `Journal/`                  |   284 | Excluded. Private personal material.                          |
| `SubZeroDev.Journal/`       |    30 | Excluded. The owner's blog and journal.                       |
| `**/raw/` transcripts       |   106 | Excluded at first. Verbatim, up to 570 KB, and the noisiest.  |
| other `SubZeroDev.*` dirs   |  ~120 | Included. One namespace per project folder.                   |
| `Stoic`, `General`, `Notes` |    25 | Included. `Notes` and `General` map by their subfolder.       |
| `.json`                     |   135 | Skipped by file type and counted.                             |
| `.md` and `.txt`            |   364 | The candidate set, before the excludes above. 313 md, 51 txt. |

## Owner decisions (2026-11-13)

1. **Consent.** The repository is `The-Running-Dev/SubZeroDev.Notes`. Exclude `Journal/**`,
   `SubZeroDev.Journal/**` and every `raw/` transcript. Anything not named in `include` is
   never read.
2. **Namespaces.** One per project folder. `Notes/` and `General/` hold subfolders, so those
   two map by their first two path segments. Unmapped folders are skipped and reported.
3. **Sync.** `auto` is on from the start: every Notes commit is synced by the bounded
   SessionStart check, all the time. Records land as `candidate` and stay reviewable; the
   owner can switch the source to `accepted` after the first review.
4. **Open.** `raw/` stays out until step 5 of the runbook shows whether it is needed.

## Runbook

1. **Prerequisite.** This host has no MemoryKit profile, store or installed `memorykit`
   command. Run from a built checkout of this repository, or install it first. Installing
   globally is the separate cutover that stays out of scope.
2. **Write the profile.** One `sources[]` entry: `repository` `D:/Dropbox/Notes`, `ref`
   `main`, explicit `include` of the chosen folders, `exclude`
   `["Journal/**", "SubZeroDev.Journal/**", "**/raw/**"]`, a namespace map, `status`
   `candidate`, `auto` `true`.
3. **`memorykit source plan`.** Read the counts. Check that the excluded folders appear only
   as counts, that no file is skipped for a secret rule without a reason you accept, and that
   the unmapped count matches the folders you left out.
4. **`memorykit source sync`, once.** It reads committed objects only and writes nothing to
   the repository. No model is needed.
5. **Verify recall.** Ask five questions with known answers, one per project, through
   `retrieve`, and one question no note answers. Each answer must cite its note path and
   commit, and the no-answer question must return nothing.
6. **Review the candidates.** Accept, correct or archive. A correction made through `update`
   is kept when its file changes later, and reported as a `conflict`.
7. **Reinstall the host hooks**, so `auto` takes effect and each new `/note` commit is synced.

## Behaviour to expect

- Recall is S17 lexical `retrieve`, and S31 showed no local source finds everything the
  expansion call does. A paraphrased question can miss a note that shares no words with it.
- Daily automatic recall stays opt-in: S26's cold p95 is above 10 s on this host
  ([decision](90-decisions.md), 2026-11-13). Syncing a source automatically does not change
  that.
- Each `/note` save adds three files in one commit, so one save becomes three records. They
  are not deduplicated (out of scope in 45).
- With `auto` on and status `candidate`, every upstream edit re-queues its record for review.

## Rollback

Remove `auto` or the source from the profile and reinstall the hooks. Records stay as
candidates; archive them by key prefix `git:notes:`. The Notes repository is never modified,
so there is nothing to undo there.

## Limits

No new code, tests or slice ids. Relative links between the three files of a save are not
turned into memory links, and `raw/` import needs its own decision after step 5.
