/// The longest feedback message the server will accept, in characters.
///
/// MIRRORS `WORKER_FEEDBACK_MESSAGE_MAX` in `packages/types`, which the DTO and
/// the `worker_feedback_message_len_chk` CHECK both pin. #1013: the app used to
/// impose NO cap at all, so a worker who kept typing hit a 400 that the mapper
/// rendered as "Server error (400). Thodi der baad try karein." — an instruction
/// to wait for something that would fail identically forever, with a paragraph
/// of their words behind it.
///
/// The client cap is the FIRST fix and not the only one: a bound the worker
/// cannot cross beats any error message about crossing it. The 400 is still made
/// recoverable (see [InvalidRequestFailure]) because a client cap only protects
/// the clients that ship with it.
///
/// The client counts RAW characters while the server measures the TRIMMED string,
/// which makes this bound strictly conservative — trailing spaces can only ever
/// shorten what the server sees.
const int kWorkerFeedbackMessageMax = 4000;

/// The most images a worker may attach to one feedback submission.
///
/// MIRRORS the server DTO's `attachment_paths ... .max(3)` (see the locked
/// contract). The add affordance hides at this count, so the worker cannot pick a
/// fourth image the server would then reject — the same "a bound they cannot
/// cross beats an error about crossing it" posture as [kWorkerFeedbackMessageMax].
const int kFeedbackMaxImages = 3;

/// How close to the cap the character counter appears.
///
/// It stays HIDDEN until then on purpose. A "0 / 4000" sitting under an empty box
/// reads as a quota to fill, and the whole point of this screen is that a worker
/// who wants to type four words is done in four words. The counter is a warning,
/// not a target — so it shows up only once the ceiling is close enough to matter.
const int kFeedbackCounterShowsWithin = 300;
