import '../../../core/api/api_client.dart' show WorkPrefOptionsDto;
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
}
