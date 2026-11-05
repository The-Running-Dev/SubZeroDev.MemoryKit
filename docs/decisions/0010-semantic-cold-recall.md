# ADR-0010: Smaller semantic prompts and observable cold recall

Status: Accepted for this implementation, 2026-11-03.

Keep the public extractive provider contract and three-stage discovery/selection/verification
workflow. Shorten the supplied adapters' prompts while retaining subject-and-property matching,
synonyms, concrete category members, partial/competing answers, false-premise corrections,
project isolation and abstention. Expansion receives only the task text, rather than protocol
metadata. Prompts contain general examples, never evaluation answers or query-specific aliases.
The model still cannot choose scopes or generate injected identities and revisions.

Expose an explicit optional Ollama CPU thread count without changing its automatic default.
Context/output settings remain explicit and model/hardware dependent. No model is downloaded,
no larger deadline or readiness threshold is introduced, and verification is not bypassed.

Record each provider phase's elapsed time and completion status in synthetic qualification
reports, and include expansion in opt-in traces. Report full cold quality and latency separately
from focused diagnosis and repeated-query caches. Preserve failed runs. Changing a prompt or
runtime configuration requires a new qualification and provider identity; an executable version
and archive digest are additional evidence, not covered by the configuration fingerprint alone.
