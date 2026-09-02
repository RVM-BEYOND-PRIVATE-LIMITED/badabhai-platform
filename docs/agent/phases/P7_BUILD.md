PHASE P7 — turn on PACE, add the push floor.

Two things.

1. Set PACE_ENABLED to true. Before enabling, verify the built behaviour matches the
   locked spec:
     Wave 1 is about 3x the vacancy count
     thin supply widens over 6 to 24 hours in this order:
       wider area -> adjacent trades -> alert ops
     it pauses when the purchased applicant quota is reached
   The "adjacent trades" wave MUST read the adjacency config from matching_catalog.
   If it uses its own separate list, that is a spec-versus-code conflict. HALT.

2. PUSH FLOOR 40 out of 100. Below the floor a worker still SEES the job in their feed
   but does not get a push notification. This is a locked rule.
   It does not appear in the Sept-1 codebase report, so first find out whether it
   exists at all. If it is missing, add it to the push processor. If it exists,
   verify the threshold and report the file and line.

INVARIANT: PACE only ever widens, never narrows.
           The push floor stops notifications, never visibility.
