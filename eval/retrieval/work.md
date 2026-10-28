# Query work

Commit `fd99f7f3c97b759bf4ae264ca0608b8f1f52e6a9` (with uncommitted changes). Node v26.12.1 on win32 x64, 11th Gen Intel(R) Core(TM) i7-11850H @ 2.50GHz, SQLite 3.54.0.

Synthetic stores built straight into the tables, both full-text indexes included: 100 namespaces `team/N/proj/M` of about 1% each, `solo/notes` with 20 rows, 10% archived, "harbor" in about 90% of memories, "lighthouse" in 10, and metadata `batch` = 7 in 0.1%. Each query runs the adapter's own SQL (`scanSql`) and scan loop (`scan`) on a file database, without the SDK, with the default scan budget of 10,000, active memories only unless the shape says otherwise. A retrieve shape matches any of its words in the stemmed index and ranks every match before the page, as retrieve does; its page here stops at 10 items, without retrieve's precision rule, so it is the most the scan can cost. Times are medians of 5 runs after one warm-up run. First row is preparing the statement and reading one row; page is the scan loop until 10 items, the budget or the end.

## 10,000 memories

| Shape | First row (ms) | Page (ms) | Rows examined | Items | Partial |
| --- | --- | --- | --- | --- | --- |
| a term matching most memories | 14.50 | 18.61 | 12 | 10 | no |
| a rare term | 0.17 | 0.21 | 10 | 10 | no |
| a term within one namespace | 21.05 | 26.48 | 1,297 | 10 | no |
| a namespace prefix, no text | 2.89 | 3.05 | 11 | 10 | no |
| all readable namespaces, no text | 0.02 | 0.06 | 11 | 10 | no |
| a selective metadata filter | 0.02 | 61.23 | 9,000 | 10 | no |
| a small namespace prefix, no text | 0.07 | 0.11 | 11 | 10 | no |
| a small namespace in two states, no text | 0.06 | 0.09 | 11 | 10 | no |
| retrieve: a term matching most memories | 22.01 | 22.79 | 12 | 10 | no |
| retrieve: a rare term | 0.21 | 0.24 | 10 | 10 | no |
| retrieve: a common and a rare term | 21.49 | 31.53 | 11 | 10 | no |
| retrieve: a term within one namespace | 23.33 | 27.43 | 1,297 | 10 | no |

## 50,000 memories

| Shape | First row (ms) | Page (ms) | Rows examined | Items | Partial |
| --- | --- | --- | --- | --- | --- |
| a term matching most memories | 81.36 | 108.79 | 12 | 10 | no |
| a rare term | 0.36 | 0.47 | 10 | 10 | no |
| a term within one namespace | 132.23 | 105.15 | 649 | 10 | no |
| a namespace prefix, no text | 29.70 | 34.74 | 11 | 10 | no |
| all readable namespaces, no text | 0.08 | 0.17 | 11 | 10 | no |
| a selective metadata filter | 0.05 | 95.28 | 7,583 | 10 | no |
| a small namespace prefix, no text | 0.06 | 0.18 | 11 | 10 | no |
| a small namespace in two states, no text | 0.09 | 0.15 | 11 | 10 | no |
| retrieve: a term matching most memories | 163.13 | 142.04 | 12 | 10 | no |
| retrieve: a rare term | 0.33 | 0.41 | 10 | 10 | no |
| retrieve: a common and a rare term | 149.33 | 135.32 | 11 | 10 | no |
| retrieve: a term within one namespace | 163.81 | 150.75 | 649 | 10 | no |

## 100,000 memories

| Shape | First row (ms) | Page (ms) | Rows examined | Items | Partial |
| --- | --- | --- | --- | --- | --- |
| a term matching most memories | 157.10 | 186.08 | 12 | 10 | no |
| a rare term | 0.39 | 0.45 | 10 | 10 | no |
| a term within one namespace | 216.54 | 198.60 | 994 | 10 | no |
| a namespace prefix, no text | 72.32 | 57.97 | 11 | 10 | no |
| all readable namespaces, no text | 0.06 | 0.17 | 11 | 10 | no |
| a selective metadata filter | 0.05 | 109.54 | 10,000 | 7 | yes |
| a small namespace prefix, no text | 0.14 | 0.21 | 11 | 10 | no |
| a small namespace in two states, no text | 0.12 | 0.19 | 11 | 10 | no |
| retrieve: a term matching most memories | 295.64 | 278.84 | 12 | 10 | no |
| retrieve: a rare term | 0.35 | 0.27 | 10 | 10 | no |
| retrieve: a common and a rare term | 299.31 | 300.23 | 11 | 10 | no |
| retrieve: a term within one namespace | 287.28 | 261.78 | 994 | 10 | no |

## Decision rules

Fixed in `design/30-slices.md` before the benchmark ran.

| Rule | Measured | Applies |
| --- | --- | --- |
| S16.3: an ordering index makes the first row of a listing over all namespaces at least twice as fast at 50,000 | 92.27 ms without, 0.08 ms with (1146.2×) | yes |
| S16.4: the first row of a term matching most memories at 100,000 takes more than 50 ms with the text query before S16 | 441.93 ms before, 157.10 ms now | yes |

## Query plans at 100,000 memories

a term matching most memories:

```text
CO-ROUTINE c
  SCAN memories_fts VIRTUAL TABLE INDEX 0:M4
  USE TEMP B-TREE FOR ORDER BY
SCAN c
SEARCH m USING INDEX sqlite_autoindex_memories_1 (id=?)
```

a rare term:

```text
CO-ROUTINE c
  SCAN memories_fts VIRTUAL TABLE INDEX 0:M4
  USE TEMP B-TREE FOR ORDER BY
SCAN c
SEARCH m USING INDEX sqlite_autoindex_memories_1 (id=?)
```

a term within one namespace:

```text
CO-ROUTINE c
  SCAN memories_fts VIRTUAL TABLE INDEX 0:M4
  USE TEMP B-TREE FOR ORDER BY
SCAN c
SEARCH m USING INDEX sqlite_autoindex_memories_1 (id=?)
```

a namespace prefix, no text:

```text
MULTI-INDEX OR
  INDEX 1
    SEARCH memories USING INDEX memories_ns_state_updated (namespace=? AND state=?)
  INDEX 2
    SEARCH memories USING INDEX memories_ns_state_updated (namespace>? AND namespace<?)
USE TEMP B-TREE FOR ORDER BY
```

all readable namespaces, no text:

```text
SCAN memories USING INDEX memories_updated
```

a selective metadata filter:

```text
SCAN memories USING INDEX memories_updated
```

a small namespace prefix, no text:

```text
MULTI-INDEX OR
  INDEX 1
    SEARCH memories USING INDEX memories_ns_state_updated (namespace=? AND state=?)
  INDEX 2
    SEARCH memories USING INDEX memories_ns_state_updated (namespace>? AND namespace<?)
USE TEMP B-TREE FOR ORDER BY
```

a small namespace in two states, no text:

```text
SEARCH memories USING INDEX memories_ns_state_updated (namespace=? AND state=?)
USE TEMP B-TREE FOR ORDER BY
```

retrieve: a term matching most memories:

```text
CO-ROUTINE c
  SCAN memories_stem VIRTUAL TABLE INDEX 0:M4
  USE TEMP B-TREE FOR ORDER BY
SCAN c
SEARCH m USING INDEX sqlite_autoindex_memories_1 (id=?)
```

retrieve: a rare term:

```text
CO-ROUTINE c
  SCAN memories_stem VIRTUAL TABLE INDEX 0:M4
  USE TEMP B-TREE FOR ORDER BY
SCAN c
SEARCH m USING INDEX sqlite_autoindex_memories_1 (id=?)
```

retrieve: a common and a rare term:

```text
CO-ROUTINE c
  SCAN memories_stem VIRTUAL TABLE INDEX 0:M4
  USE TEMP B-TREE FOR ORDER BY
SCAN c
SEARCH m USING INDEX sqlite_autoindex_memories_1 (id=?)
```

retrieve: a term within one namespace:

```text
CO-ROUTINE c
  SCAN memories_stem VIRTUAL TABLE INDEX 0:M4
  USE TEMP B-TREE FOR ORDER BY
SCAN c
SEARCH m USING INDEX sqlite_autoindex_memories_1 (id=?)
```
