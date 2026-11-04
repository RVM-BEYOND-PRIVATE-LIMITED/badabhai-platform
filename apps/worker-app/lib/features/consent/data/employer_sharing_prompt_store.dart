import 'package:shared_preferences/shared_preferences.dart';

import '../domain/employer_sharing_prompt_store.dart';

/// [EmployerSharingPromptStore] over `shared_preferences`, resolved lazily per
/// call so registering it never touches the platform channel.
class SharedPrefsEmployerSharingPromptStore
    implements EmployerSharingPromptStore {
  const SharedPrefsEmployerSharingPromptStore({
    Future<SharedPreferences> Function() prefs = SharedPreferences.getInstance,
  }) : _prefs = prefs;

  final Future<SharedPreferences> Function() _prefs;

  @override
  Future<bool> isDismissed({required String version, String? workerId}) async {
    try {
      final SharedPreferences prefs = await _prefs();
      return prefs.getBool(
            employerSharingDismissKey(version: version, workerId: workerId),
          ) ??
          false;
    } catch (_) {
      return false;
    }
  }

  @override
  Future<void> markDismissed({required String version, String? workerId}) async {
    try {
      final SharedPreferences prefs = await _prefs();
      await prefs.setBool(
        employerSharingDismissKey(version: version, workerId: workerId),
        true,
      );
    } catch (_) {
      // Best-effort: a lost mark only costs one more prompt next launch.
    }
  }
}

/// In-memory [EmployerSharingPromptStore]: the test seam, and the fallback for
/// a graph that registers no persisted store.
class InMemoryEmployerSharingPromptStore implements EmployerSharingPromptStore {
  final Set<String> _dismissed = <String>{};

  @override
  Future<bool> isDismissed({required String version, String? workerId}) async =>
      _dismissed.contains(
        employerSharingDismissKey(version: version, workerId: workerId),
      );

  @override
  Future<void> markDismissed({required String version, String? workerId}) async {
    _dismissed.add(
      employerSharingDismissKey(version: version, workerId: workerId),
    );
  }
}
