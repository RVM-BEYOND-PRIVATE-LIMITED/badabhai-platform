import '../../../core/api/api_models.dart';

/// The worker's three answers to the monthly check (#2753 item 5).
///
/// A CLOSED set matching the server's `STILL_LOOKING_ANSWERS`. The wire string
/// is the same as the enum name in snake_case; the mapping lives here so no
/// screen ever hand-writes a protocol value.
enum StillLookingAnswer {
  yes('yes'),
  notNow('not_now'),
  hired('hired');

  const StillLookingAnswer(this.wire);

  /// The exact value `POST /workers/me/still-looking` validates.
  final String wire;
}

/// The monthly "still looking?" check (#2753 item 5).
///
/// SERVER TRUTH ONLY: `due`, `availability_needs_answer`, `last_active_on`
/// and `not_recently_active` always come from the endpoint; the client never
/// derives one from the other. A `404` means `STILL_LOOKING_CHECK_ENABLED` is
/// off (no card, no banner); a `503` is retryable. Implementations throw a
/// typed failure on error.
abstract interface class StillLookingRepository {
  Future<StillLookingDto> read();

  /// Answers the open check, or opens and answers one when none is open. The
  /// reply is the GET shape, so callers redraw from it without a second read.
  Future<StillLookingDto> answer(StillLookingAnswer answer);
}
