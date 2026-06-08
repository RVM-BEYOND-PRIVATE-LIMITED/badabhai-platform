# @badabhai/taxonomy

Canonical **placeholder** taxonomy for Phase 1 (industrial manufacturing,
CNC/VMC): `INDUSTRIES`, `DOMAINS`, `ROLES`, `SKILLS`, `MACHINES`, plus `getRole`,
`getMachine`, etc. lookups.

IDs are **stable** (e.g. `role_vmc_operator`): AI extraction canonicalizes free
text into these ids and the DB stores `canonical_*_id` references. The lists will
grow, but existing ids must never change.

Initial roles: CNC Turner/Operator · VMC Operator · HMC Operator ·
CNC Setter-Operator · CNC Programmer · CAM Programmer · CNC Grinding Operator.
