import '../../../core/api/api_models.dart';

/// The worker's "Companies can find me in search" switch (#2753 item 6).
///
/// SERVER TRUTH ONLY: the value and `hidden_since` always come from
/// `GET|PUT /workers/me/search-visibility`; nothing is derived locally. A
/// `404` means `SEARCH_EXIT_ENABLED` is off (the caller hides the control); a
/// `503` is retryable. Implementations throw a typed failure on error.
abstract interface class SearchVisibilityRepository {
  Future<SearchVisibilityDto> read();

  /// Sets the RESULTING state (not a toggle) and returns the server's answer.
  Future<SearchVisibilityDto> setVisible(bool visible);
}
