/// Remembers, ON THIS DEVICE, that a worker answered "not now" to the home
/// shell's availability prompt (#2748 item 1d), so they are not asked again.
///
/// KEYED PER WORKER, so it is never cleared on logout: the next worker on a
/// shared phone has their own key (and is still asked), and the same worker is
/// not re-asked after a re-login. The key carries the opaque worker UUID (the
/// same id the secure store and crash attribution already hold); the value is
/// a bare flag — no name, phone or answer. Same shape as the employer-sharing
/// prompt's store, without the notice version.
abstract interface class AvailabilityPromptStore {
  /// Whether [workerId] dismissed the prompt here. NEVER throws — an
  /// unreadable store reads as "not dismissed".
  Future<bool> isDismissed({String? workerId});

  /// Records the dismissal. Best-effort — NEVER throws.
  Future<void> markDismissed({String? workerId});
}

/// `bb_`-prefixed to match the existing prefs key convention.
const String kAvailabilityPromptDismissKeyPrefix =
    'bb_availability_prompt_dismissed_';

/// The prefs key for one worker. A missing worker id falls back to one
/// device-wide slot rather than not remembering at all.
String availabilityPromptDismissKey({String? workerId}) {
  final String who = (workerId == null || workerId.isEmpty)
      ? 'device'
      : workerId;
  return '$kAvailabilityPromptDismissKeyPrefix$who';
}
