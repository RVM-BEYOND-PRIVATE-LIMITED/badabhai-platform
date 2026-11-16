import 'display_prefs.dart';

/// The payer's saved display (theme) preference — `/payer/me/display-prefs`.
///
/// The server row is authoritative and follows the person across phones and
/// between the app and payer-web. The client keeps `{ choice, open }` on the
/// device only as a first-paint cache and as an offline queue.
///
/// Contract (docs/api/display-prefs-api-reference.md):
/// * `theme_open: false` (or any non-200 GET) means **Light, no choice**.
/// * A `PATCH` 404 means the switch closed meanwhile: fall back to Light.
/// * Never cache across logins: the theme belongs to the token's login.
abstract class DisplayPrefsRepository {
  /// The server's current reply, or the cached reply when the network is
  /// unavailable. Never throws.
  Future<DisplayPrefs> read();

  /// Applies [theme] at once and persists it. The local cache is written first
  /// so the choice survives an offline device; a failed PATCH is queued and
  /// flushed by [flushPending]. Never throws.
  Future<DisplayPrefs> write(DisplayTheme theme);

  /// Sends a queued offline choice, if any. Call on resume / sign-in.
  Future<void> flushPending();

  /// Drops the device cache on logout so the next payer does not inherit the
  /// previous payer's theme.
  void onLogout();
}
