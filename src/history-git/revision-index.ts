import { createHash } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

// What one commit says about itself: its parent, and the memory revision it exported. A commit id
// fixes all of these, so an entry is never out of date for its commit; only which commits are on
// the branch changes, and that is read from Git each time.
export interface IndexEntry {
  commit: string;
  parent: string | null;
  memoryId: string;
  revision: number;
  dir: string; // <namespace>/<memoryId>, from the subject
}

const HEADER = 'memorykit-revisions 1\n';
const COMMIT = /^[0-9a-f]{40,64}$/;

// A rebuildable index from a memory's directory to the commits that exported its revisions, kept
// as an append-only file beside the repository. Git stays authoritative: the caller reads every
// revision it returns from the commit itself, and rebuilds the index from the branch when an entry
// is missing, unreadable or disagrees with its commit. Each line carries a checksum, so a torn or
// damaged line is skipped as if it were missing.
export class RevisionIndex {
  private readonly path: string;
  private readonly entries = new Map<string, IndexEntry>();
  private offset = 0; // bytes of the file already read
  private head: string | null = null; // the commit the chain below ends at
  private chain = new Map<string, IndexEntry[]>(); // by dir, oldest first
  private readonly verified = new WeakSet<IndexEntry>();
  private readonly unchecked = new Set<IndexEntry>(); // on this chain, not yet checked against Git

  constructor(path: string) {
    this.path = path;
  }

  // Candidate entries for a directory, oldest first, plus all unchecked entries on the indexed
  // chain. Null when a commit on that chain is missing. The caller must verify the unchecked
  // labels and parent links against Git before treating a candidate set as complete.
  lookup(
    head: string,
    dir: string
  ): { entries: IndexEntry[]; unchecked: ReadonlySet<IndexEntry> } | null {
    if (head !== this.head && !this.advance(head)) return null;
    return { entries: this.chain.get(dir) ?? [], unchecked: this.unchecked };
  }

  // Only the caller's successful comparison with Git can establish completeness. A checksum
  // cannot: a well-formed entry can mislabel a commit or skip its real parent.
  confirm(entries: IndexEntry[]): void {
    for (const entry of entries) {
      this.verified.add(entry);
      this.unchecked.delete(entry);
    }
  }

  // Records a commit this process has just put on the branch. A failure only costs a rebuild.
  append(entry: IndexEntry): void {
    try {
      const text = line(entry);
      if (existsSync(this.path)) {
        appendFileSync(this.path, text);
      } else {
        mkdirSync(dirname(this.path), { recursive: true });
        writeFileSync(this.path, HEADER + text, { flag: 'wx' });
      }
    } catch {
      // The next read finds the gap and rebuilds.
    }
  }

  // Replaces the index with the branch as Git lists it, newest first.
  rebuild(head: string | null, commits: IndexEntry[]): void {
    for (const entry of commits) this.entries.set(entry.commit, entry);
    this.head = null;
    this.chain = new Map();
    this.unchecked.clear();
    const text = HEADER + commits.map(line).join('');
    const temporary = `${this.path}.${process.pid}.tmp`;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(temporary, text);
      renameSync(temporary, this.path);
      this.offset = Buffer.byteLength(text);
    } catch {
      // Another process holds the file open, as on Windows: keep the entries in memory and read
      // on from the end of the file as it stands.
      rmSync(temporary, { force: true });
      try {
        this.offset = statSync(this.path).size;
      } catch {
        this.offset = 0;
      }
    }
    if (head !== null) this.advance(head);
  }

  // Walks back from `head` until the chain already known, or the root when the branch was
  // replaced. Entries off that chain, such as those of a discarded branch, are never returned.
  private advance(head: string): boolean {
    this.read();
    const walked: IndexEntry[] = [];
    let commit: string | null = head;
    while (commit !== null && commit !== this.head) {
      const entry = this.entries.get(commit);
      // A gap, or a loop that only damaged entries could make.
      if (entry === undefined || walked.length > this.entries.size) return false;
      walked.push(entry);
      commit = entry.parent;
    }
    if (commit === null) {
      this.chain = new Map();
      this.unchecked.clear();
    }
    for (const entry of walked.reverse()) {
      if (!this.verified.has(entry)) this.unchecked.add(entry);
      const list = this.chain.get(entry.dir);
      if (list) list.push(entry);
      else this.chain.set(entry.dir, [entry]);
    }
    this.head = head;
    return true;
  }

  // Reads the lines appended since the last read. A last line without its newline may still be
  // being written, so it is left for the next read.
  private read(): void {
    let fd: number;
    try {
      fd = openSync(this.path, 'r');
    } catch {
      return;
    }
    try {
      const size = fstatSync(fd).size;
      if (size < this.offset) this.offset = 0; // replaced by a rebuild elsewhere
      if (size === this.offset) return;
      const buffer = Buffer.alloc(size - this.offset);
      readSync(fd, buffer, 0, buffer.length, this.offset);
      const end = buffer.lastIndexOf(0x0a);
      if (end < 0) return;
      let text = buffer.subarray(0, end + 1).toString('utf8');
      if (this.offset === 0) {
        if (!text.startsWith(HEADER)) {
          // Not an index this code wrote: ignore all of it, and a rebuild replaces it.
          this.offset = size;
          return;
        }
        text = text.slice(HEADER.length);
      }
      this.offset += end + 1;
      for (const row of text.split('\n')) {
        const entry = parse(row);
        if (entry !== null) this.entries.set(entry.commit, entry);
      }
    } finally {
      closeSync(fd);
    }
  }
}

function checksum(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function line(entry: IndexEntry): string {
  const body = [entry.commit, entry.parent ?? '', entry.memoryId, String(entry.revision), entry.dir]
    .map(encodeURIComponent)
    .join(' ');
  return `${body} ${checksum(body)}\n`;
}

function parse(row: string): IndexEntry | null {
  const split = row.lastIndexOf(' ');
  if (split < 0) return null;
  const body = row.slice(0, split);
  if (checksum(body) !== row.slice(split + 1)) return null;
  const fields = body.split(' ');
  if (fields.length !== 5) return null;
  try {
    const [commit, parent, memoryId, revision, dir] = fields.map(decodeURIComponent) as [
      string,
      string,
      string,
      string,
      string,
    ];
    if (!COMMIT.test(commit) || (parent !== '' && !COMMIT.test(parent))) return null;
    if (!/^\d+$/.test(revision)) return null;
    return {
      commit,
      parent: parent === '' ? null : parent,
      memoryId,
      revision: Number(revision),
      dir,
    };
  } catch {
    return null;
  }
}
