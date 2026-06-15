# Project Registers — Working Memory

These files are BadaBhai's living memory. They are **append-and-update**, not
write-once. Keeping them current is part of the [Definition of Done](../engineering-org/development-workflow.md#definition-of-done).

| Register | What goes here | Update when |
| -------- | -------------- | ----------- |
| [decisions-log.md](./decisions-log.md) | Index of all decisions (ADRs + lightweight) | Any decision is made |
| [architecture-log.md](./architecture-log.md) | Chronological record of architectural state & changes | Architecture changes |
| [risks-register.md](./risks-register.md) | Known risks, severity, mitigation, owner | A risk is found, changes, or closes |
| [tech-debt-register.md](./tech-debt-register.md) | Deliberate shortcuts + their payback trigger | You take a shortcut, or pay one back |
| [future-improvements.md](./future-improvements.md) | Ideas / Phase 2+ work not yet scheduled | An idea worth keeping appears |
| [open-questions.md](./open-questions.md) | Unknowns blocking or shaping decisions | A question opens or gets answered |
| [team-decisions.md](./team-decisions.md) | Lightweight decisions not worth a full ADR | A non-architectural call is made |
| [trade-content-ratification.md](./trade-content-ratification.md) | Per-trade resume/interview-kit content review status (RVM human gate) | Trade content is drafted, edited, or RVM-ratified |

**ADR vs team-decision vs tech-debt:**
- *Architectural / hard-to-reverse / cross-cutting* → write an [ADR](../decisions/).
- *A call the team made (priority, scope, vendor lean, process)* → team-decisions.
- *A conscious shortcut you'll pay back later* → tech-debt (with a trigger).
