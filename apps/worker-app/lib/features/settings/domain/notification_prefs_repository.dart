/// The worker's MASTER Notifications on/off preference (Settings → Notifications).
///
/// OFF = the worker receives NO push notifications of any type; ON = all types.
/// The actual push suppression is enforced BACKEND-SIDE (the send path skips a
/// disabled worker) — this preference is the switch that gates it. The client
/// keeps a local cache so the toggle is instant + survives restart, and syncs the
/// choice to the server (where it becomes cross-device + actually effective).
abstract class NotificationPrefsRepository {
  /// The current setting. Prefers the SERVER value (authoritative + cross-device)
  /// when reachable; falls back to the local cached value — default ON — when the
  /// endpoint is unavailable (offline, or before the backend ships it).
  Future<bool> isEnabled();

  /// Persist the choice: writes the local cache IMMEDIATELY (so the toggle sticks)
  /// then best-effort PATCHes the server. Never throws — a failed server sync
  /// leaves the local value in place to retry on the next change.
  Future<void> setEnabled(bool enabled);

  /// Drop the local cache on logout so the next worker on this device does not
  /// inherit the previous worker's toggle (cross-user isolation).
  void onLogout();
}
