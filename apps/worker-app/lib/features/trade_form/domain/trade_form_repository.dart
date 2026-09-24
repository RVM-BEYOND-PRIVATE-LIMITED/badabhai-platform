import 'profiling_tier.dart';
import '../../../core/api/api_client.dart'
    show QualificationOptionsDto, WorkPrefOptionsDto;
import 'trade_form_models.dart';

/// The trade form's data boundary (#1341): read the whole form, save one
/// question at a time, and persist the two marker-screen writes.
abstract interface class TradeFormRepository {
  /// GET the whole form. `null` means this worker was never handed a form —
  /// a DIFFERENT thing from an empty form; the caller must render an honest
  /// "nothing to fill here" state rather than a blank one.
  ///
  /// [upgradeView] asks for `?view=upgrade` (#1698): ONLY the questions this
  /// worker has not answered yet, plus the pages a tier upgrade added fields
  /// to. It is passed exactly once — straight after the server answered a tier
  /// tap with `change: "upgraded"` — and never on an ordinary load, so a
  /// worker who simply re-opens their form still gets the whole thing.
  Future<TradeForm?> loadForm({bool upgradeView = false});

  /// GET /profiling/form/tiers — may this worker choose how long profiling
  /// takes, and what do the tiers cost them (#1698)?
  ///
  /// NEVER THROWS. Every reason the question cannot be answered —
  /// `PROFILING_TIERS_ENABLED` off, a pack not yet re-seeded, a 404 because no
  /// form was ever handed over, a 5xx, no network — resolves to
  /// [TierState.disabled], which means "open the full form exactly as today".
  /// This gate sits in front of a road the worker is already walking; it must
  /// never be the thing that stops them.
  Future<TierState> loadTierState();

  /// POST /profiling/form/tier — the worker tapped a tier card (#1698).
  ///
  /// UNLIKE [loadTierState] this PROPAGATES a [Failure]: the tap is a
  /// deliberate choice about how much of their time the worker is giving, and
  /// a silent failure would open a form at a tier they did not pick. Returns
  /// null only when the server answered 200 with a body this build cannot
  /// read — the caller then opens the full form rather than inventing a tier.
  ///
  /// A downgrade is a 409 server-side and is never offered by this app.
  Future<TierChoice?> chooseTier(ProfilingTier tier);

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
