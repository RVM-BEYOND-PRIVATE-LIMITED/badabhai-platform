PHASE P5 — employer facets that never hide anyone, plus small-pool hot tag.

Add:  GET /payer/reach/jobs/:id/applicants?facet=<attribute>:<value>

The facet REORDERS the list. It never filters, never scores, never removes anyone.
The response carries a count badge, for example "14 of 62 match Fanuc".
Valid facet keys come from the per-role attribute whitelist in matching_catalog.
An unknown facet key returns 400. It must not be silently ignored.

Hot tag: locked at about 12 percent (HOT_TOP_RATIO = 0.12) with a minimum floor of 70.
When the pool has fewer than 70 candidates, turn the hot tag OFF completely and return
small_pool: true. Do not tag everybody hot. A meaningless signal is worse than none.

INVARIANT: a facet never changes which candidates are in the result.
