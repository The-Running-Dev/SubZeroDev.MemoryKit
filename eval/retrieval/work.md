# Query work

Commit `5b65222cd96f07ea426d20cd5e4e615d153a5673` (with uncommitted changes). Node v26.12.1 on win32 x64, 11th Gen Intel(R) Core(TM) i7-11850H @ 2.50GHz, SQLite 3.54.0.

Synthetic stores built straight into the tables: 100 namespaces `team/N/proj/M` of about 1% each, `solo/notes` with 20 rows, 10% archived, "harbor" in about 90% of memories, "lighthouse" in 10, and metadata `batch` = 7 in 0.1%. Each query runs the adapter's own SQL (`scanSql`) and scan loop (`scan`) on a file database, without the SDK, with the default scan budget of 10,000, active memories only unless the shape says otherwise. Times are medians of 5 runs after one warm-up run. First row is preparing the statement and reading one row; page is the scan loop until 10 items, the budget or the end.

## 10,000 memories

| Shape | First row (ms) | Page (ms) | Rows examined | Items | Partial |
| --- | --- | --- | --- | --- | --- |
| a term matching most memories | 16.93 | 25.26 | 12 | 10 | no |
| a rare term | 0.21 | 0.28 | 10 | 10 | no |
| a term within one namespace | 34.58 | 38.05 | 1,297 | 10 | no |
| a namespace prefix, no text | 5.00 | 4.42 | 11 | 10 | no |
| all readable namespaces, no text | 0.04 | 0.09 | 11 | 10 | no |
| a selective metadata filter | 0.03 | 76.67 | 9,000 | 10 | no |
| a small namespace prefix, no text | 0.08 | 0.15 | 11 | 10 | no |
| a small namespace in two states, no text | 0.09 | 0.14 | 11 | 10 | no |

## 50,000 memories

| Shape | First row (ms) | Page (ms) | Rows examined | Items | Partial |
| --- | --- | --- | --- | --- | --- |
| a term matching most memories | 96.92 | 122.71 | 12 | 10 | no |
| a rare term | 0.37 | 0.54 | 10 | 10 | no |
| a term within one namespace | 164.98 | 146.34 | 649 | 10 | no |
| a namespace prefix, no text | 54.07 | 49.96 | 11 | 10 | no |
| all readable namespaces, no text | 0.07 | 0.16 | 11 | 10 | no |
| a selective metadata filter | 0.03 | 111.38 | 7,583 | 10 | no |
| a small namespace prefix, no text | 0.18 | 0.22 | 11 | 10 | no |
| a small namespace in two states, no text | 0.13 | 0.21 | 11 | 10 | no |

## 100,000 memories

| Shape | First row (ms) | Page (ms) | Rows examined | Items | Partial |
| --- | --- | --- | --- | --- | --- |
| a term matching most memories | 189.56 | 246.83 | 12 | 10 | no |
| a rare term | 0.21 | 0.29 | 10 | 10 | no |
| a term within one namespace | 285.79 | 257.37 | 994 | 10 | no |
| a namespace prefix, no text | 98.57 | 87.43 | 11 | 10 | no |
| all readable namespaces, no text | 0.03 | 0.08 | 11 | 10 | no |
| a selective metadata filter | 0.03 | 157.73 | 10,000 | 7 | yes |
| a small namespace prefix, no text | 0.07 | 0.13 | 11 | 10 | no |
| a small namespace in two states, no text | 0.11 | 0.11 | 11 | 10 | no |

## Decision rules

Fixed in `design/30-slices.md` before the benchmark ran.

| Rule | Measured | Applies |
| --- | --- | --- |
| S16.3: an ordering index makes the first row of a listing over all namespaces at least twice as fast at 50,000 | 86.19 ms without, 0.07 ms with (1233.0×) | yes |
| S16.4: the first row of a term matching most memories at 100,000 takes more than 50 ms with the text query before S16 | 535.81 ms before, 189.56 ms now | yes |

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
