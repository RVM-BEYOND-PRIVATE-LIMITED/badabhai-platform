import '../../../core/api/api_client.dart';
import '../../../core/error/failure.dart';
import '../../../core/error/failure_mapper.dart';
import '../../../core/session/session_repository.dart';
import '../domain/resume_edit_repository.dart';
import '../domain/resume_safe_fields.dart';

/// Real resume safe-field source (follows the auth/chat/resume real-repo pattern:
/// ctor takes the [ApiClient] + [SessionRepository], NOT a hardcoded mock).
///
/// LOAD → `GET /workers/me/resume-fields` (the worker's OWN name spelling + display
/// prefs). SAVE → the name goes to the hardened `PATCH /workers/me/name` (encrypted
/// at rest, emits `worker.name_recorded`), and the prefs to `PATCH
/// /workers/me/resume-prefs` (emits `worker.resume_prefs_updated`). The plaintext
/// name passes through here only in transit and is never retained/logged.
class ResumeEditRepositoryImpl implements ResumeEditRepository {
  ResumeEditRepositoryImpl(this._api, this._session);

  final ApiClient _api;
  final SessionRepository _session;

  /// The name spelling last loaded from the server. `save()` re-sends the name
  /// (which re-encrypts it + re-emits `worker.name_recorded`) ONLY when the worker
  /// actually changed it — a prefs-only save must not churn the PII spine. Null
  /// until a load has happened (defensive: a save without a prior load falls back
  /// to sending any non-empty name).
  String? _loadedName;

  @override
  Future<ResumeSafeFields> load() async {
    final String? token = _session.sessionToken;
    if (token == null) {
      throw const UnauthorizedFailure();
    }
    try {
      final ResumeFieldsDto f = await _api.getResumeFields(authToken: token);
      // `full_name` is null until the worker sets a name — show an empty spelling
      // to fill in rather than a fabricated placeholder.
      final String name = f.fullName ?? '';
      _loadedName = name;
      return ResumeSafeFields(
        displayName: name,
        showPhoto: f.showPhoto,
        nightShiftReady: f.nightShiftReady,
        hasPhoto: f.hasPhoto,
      );
    } catch (error) {
      throw mapError(error);
    }
  }

  @override
  Future<void> save(ResumeSafeFields fields) async {
    final String? token = _session.sessionToken;
    if (token == null) {
      throw const UnauthorizedFailure();
    }
    try {
      // Name only when non-empty AND actually changed — the API rejects an
      // empty/all-digits name, and a prefs-only save must not re-encrypt/re-emit
      // an unchanged name.
      final String name = fields.displayName.trim();
      if (name.isNotEmpty && name != _loadedName?.trim()) {
        await _api.updateName(fullName: name, authToken: token);
        _loadedName = name; // a re-save with the same name is now a no-op
      }
      await _api.updateResumePrefs(
        showPhoto: fields.showPhoto,
        nightShiftReady: fields.nightShiftReady,
        authToken: token,
      );
    } catch (error) {
      throw mapError(error);
    }
  }
}
