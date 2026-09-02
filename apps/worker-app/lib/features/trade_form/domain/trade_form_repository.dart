import '../../../core/api/api_client.dart'
    show QualificationOptionsDto, WorkPrefOptionsDto;
import 'trade_form_models.dart';

/// The trade form's data boundary (#1341): read the whole form, save one
/// question at a time, and persist the two marker-screen writes.
abstract interface class TradeFormRepository {
  /// GET the whole form. `null` means this worker was never handed a form —
  /// a DIFFERENT thing from an empty form; the caller must render an honest
  /// "nothing to fill here" state rather than a blank one.
  Future<TradeForm?> loadForm();

  /// POST one answer. A 400 naming an unknown `option_key` is surfaced as an
  /// [Object] `Failure` carrying that message (client/pack-version disagree —
  /// never swallowed silently).
  Future<TradeFormAnswerResult> submitAnswer({
    required String questionKey,
    required TradeFormAnswer answer,
  });

  /// GET the chip vocabulary for the `preferences` marker screen — the same
  /// options `features/finishing` already renders from.
  Future<WorkPrefOptionsDto> loadPreferenceOptions();

  /// PUT the closed-set work preferences (the `preferences` marker's write).
  Future<void> savePreferences(TradeFormPreferences prefs);

  /// PUT the work history (REPLACES the whole list; an empty list clears it) —
  /// the `employment` marker's write.
  Future<void> saveEmployment(List<TradeFormEmploymentEntry> employments);

  /// GET the slug→label vocabulary for the `qualifications` marker's
  /// education chips (`credential`/`council`) — same contract shape as
  /// [loadPreferenceOptions], for the same reason.
  Future<QualificationOptionsDto> loadQualificationOptions();

  /// PUT the worker's certificates + education rows (the `qualifications`
  /// marker's write) — TRI-STATE per list. [qualifications] owns which keys
  /// are present on the wire (see [TradeFormQualifications.toJson]); the
  /// caller must not invoke this when [TradeFormQualifications.hasAnyTouch]
  /// is false, since an empty body is the endpoint's one deliberate 400.
  Future<void> saveQualifications(TradeFormQualifications qualifications);
}
