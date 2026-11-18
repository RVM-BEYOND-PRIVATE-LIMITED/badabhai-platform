import 'package:shared_preferences/shared_preferences.dart';

import '../domain/availability_prompt_store.dart';

/// [AvailabilityPromptStore] over `shared_preferences`, resolved lazily per
/// call so registering it never touches the platform channel.
class SharedPrefsAvailabilityPromptStore implements AvailabilityPromptStore {
  const SharedPrefsAvailabilityPromptStore({
    Future<SharedPreferences> Function() prefs = SharedPreferences.getInstance,
  }) : _prefs = prefs;

  final Future<SharedPreferences> Function() _prefs;

  @override
  Future<bool> isDismissed({String? workerId}) async {
    try {
      final SharedPreferences prefs = await _prefs();
      return prefs.getBool(availabilityPromptDismissKey(workerId: workerId)) ??
          false;
    } catch (_) {
      return false;
    }
  }

  @override
  Future<void> markDismissed({String? workerId}) async {
    try {
      final SharedPreferences prefs = await _prefs();
      await prefs.setBool(
        availabilityPromptDismissKey(workerId: workerId),
        true,
      );
    } catch (_) {
      // Best-effort: a lost mark only costs one more prompt next launch.
    }
  }
}

/// In-memory [AvailabilityPromptStore]: the test seam, and the fallback for a
/// graph that registers no persisted store.
class InMemoryAvailabilityPromptStore implements AvailabilityPromptStore {
  final Set<String> _dismissed = <String>{};

  @override
  Future<bool> isDismissed({String? workerId}) async =>
      _dismissed.contains(availabilityPromptDismissKey(workerId: workerId));

  @override
  Future<void> markDismissed({String? workerId}) async {
    _dismissed.add(availabilityPromptDismissKey(workerId: workerId));
  }
}
