# Baseline

Numbers for later comparison, not targets. Produced by `npm run bench` in the `bench` CI job
(`workflow_dispatch`, ubuntu-latest), run
[40156562701](https://github.com/The-Running-Dev/SubZeroDev.MemoryKit/actions/runs/40156562701),
with Git history.

Node v24.21.0 on linux x64, AMD EPYC 7763 64-Core Processor

| Measure                    | 1,000 memories | 10,000 memories  |
| -------------------------- | -------------- | ---------------- |
| create median / p95 (ms)   | 1.03 / 1.54    | 2.28 / 4.17      |
| get median / p95 (ms)      | 0.07 / 0.11    | 0.07 / 0.10      |
| search median / p95 (ms)   | 2.44 / 2.54    | 27.12 / 28.26    |
| revision median / p95 (ms) | 94.29 / 99.14  | 928.20 / 1009.23 |
| drain (revisions/s)        | 15.6 (64.2 s)  | 4.4 (2247.8 s)   |
| database (MiB)             | 3.0            | 30.1             |
| repository (MiB)           | 3.0            | 193.6            |

Revision retrieval and drain throughput both degrade with the size of the history, unlike the
reads served from SQLite.
