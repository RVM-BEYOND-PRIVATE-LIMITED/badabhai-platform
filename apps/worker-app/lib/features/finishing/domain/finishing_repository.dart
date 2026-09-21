import '../../../core/api/api_client.dart'
    show WorkPrefOptionsDto, SessionFillDto;
import 'finishing_models.dart';

/// The post-interview finishing form's data boundary (#1296): read the chip
/// vocabulary, then persist the two closed-set writes. Both writes re-render the
/// worker's PDF server-side, best-effort — nothing for the client to do after.
abstract interface class FinishingRepository {
  /// GET the chip vocabulary (languages / documents / job_type / shift).
  Future<WorkPrefOptionsDto> loadOptions();

  /// PUT the closed-set work preferences. A 400 naming an unresolved city is
  /// surfaced as an [Object] `Failure` carrying that message.
  Future<void> saveWorkPreferences(WorkPreferences prefs);

  /// PUT the work history (REPLACES the whole list; an empty list clears it).
  Future<void> saveEmployment(List<EmploymentEntry> employments);

  /// GET the session's settled-vs-missing `fill` block (#1575). Returns null
  /// when there is no session to ask about (form road, cold start) or the read
  /// fails — the caller then shows the FULL list, exactly as before. Failing
  /// OPEN is deliberate: blocking the whole form on an informational read
  /// would strand the worker, and re-asking a settled fact is the lesser harm
  /// (the writes are idempotent rewrites of the same values).
  Future<SessionFillDto?> loadSessionFill();
}
