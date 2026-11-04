/// Remembers, ON THIS DEVICE, that a worker answered "Abhi nahi" to the
/// one-time employer-sharing prompt for one notice version.
///
/// KEYED PER WORKER AND PER NOTICE VERSION, so it is never cleared on logout:
/// the next worker on a shared phone has their own key (and still gets asked),
/// the same worker is not re-asked after a re-login, and a re-approved notice
/// (new version) asks everyone again. The key carries the opaque worker UUID
/// (the same id the secure store and crash attribution already hold); the value
/// is a bare flag — no name, phone or answer content.
abstract interface class EmployerSharingPromptStore {
  /// Whether [workerId] dismissed the [version] prompt here. NEVER throws —
  /// an unreadable store reads as "not dismissed".
  Future<bool> isDismissed({required String version, String? workerId});

  /// Records the dismissal. Best-effort — NEVER throws.
  Future<void> markDismissed({required String version, String? workerId});
}

/// `bb_`-prefixed to match the existing prefs key convention.
const String kEmployerSharingDismissKeyPrefix = 'bb_employer_sharing_dismissed_';

/// The prefs key for one worker + notice version. A missing worker id falls
/// back to one device-wide slot rather than not remembering at all.
String employerSharingDismissKey({required String version, String? workerId}) {
  final String who =
      (workerId == null || workerId.isEmpty) ? 'device' : workerId;
  return '$kEmployerSharingDismissKeyPrefix${version}_$who';
}
