import '../../../core/api/api_client.dart' show WorkPrefOptionsDto;
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
}
