PHASE P9 — separate publish, verify, and plan.

Follow section B5 of the spec. Content and money are separated.

  POST /payer/job-posting-drafts/:id/publish   [ONE transaction]
    validate the full payload against the publish schema
    insert into job_postings (status = draft, verification_status = pending)
    emit job_posting.submitted
    set draft.status = published

  ops verify -> verification_status = verified

  plan step:
    free intro band -> implicit plan, applicant_quota stamped
    paid band       -> Razorpay ON WEB -> status = open, applicant_quota stamped
                       at purchase

  open -> job_reach is built, engine_version stamped

Three properties must hold and must each have a test:
  1. A failed payment never loses the draft content.
  2. An unverified posting never enters job_reach and never reaches a worker feed.
  3. applicant_quota is stamped at the plan step, and a later pricing tier edit
     cannot change it on a live job.

Delete POST /payer/job-posting-chat/sessions/:id/publish.
There must be exactly one publish path.

Editing after publishing: reopen a draft with source_posting_id set.
  affects_matching = false -> apply the edit in place
  affects_matching = true  -> rebuild job_reach with a NEW engine_version,
                              emit an event, and leave existing application
                              snapshots frozen and untouched

INVARIANT: an unverified posting is never visible to any worker.
