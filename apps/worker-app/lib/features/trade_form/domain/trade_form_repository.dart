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

  /// GET the worker's STORED preferences, so the page opens on them (#1710).
  ///
  /// Null means there is no stored row to prefill from — a DIFFERENT thing
  /// from a stored "none of these", which comes back as empty lists. THROWS a
  /// [Failure] like every other read here: a page that silently opened blank
  /// after a failed read is exactly the blind-save this method exists to end.
  Future<TradeFormPreferences?> loadSavedPreferences();

  /// PUT the closed-set work preferences (the `preferences` marker's write).
  Future<void> savePreferences(TradeFormPreferences prefs);

  /// GET the worker's STORED work history and the count its save must echo
  /// (#1710). See [TradeFormStoredEmployment] for why the two travel together.
  ///
  /// THROWS a [Failure] on any read failure — never an empty result. The PUT
  /// REPLACES the whole list, so "I could not read it" and "there is nothing
  /// stored" must never look the same to the caller.
  Future<TradeFormStoredEmployment> loadSavedEmployment();

  /// PUT the work history (REPLACES the whole list; an empty list clears it) —
  /// the `employment` marker's write.
  ///
  /// [expectedExistingCount] is the count from the [loadSavedEmployment] this
  /// save was built on. The server compares it with the rows the replace
  /// transaction reads and answers **409** when they differ, BEFORE deleting
  /// anything; the caller must then reload and rebuild rather than re-send.
  /// Omitting it tells the server this is an old client that cannot say what
  /// it prefilled from, so callers that DID read must always pass it.
  Future<void> saveEmployment(
    List<TradeFormEmploymentEntry> employments, {
    int? expectedExistingCount,
  });

  /// GET the slug→label vocabulary for the `qualifications` marker's
  /// education chips (`credential`/`council`) — same contract shape as
  /// [loadPreferenceOptions], for the same reason.
  Future<QualificationOptionsDto> loadQualificationOptions();

  /// GET the worker's STORED certificates and education rows (#1710).
  ///
  /// Null means no stored row at all. The returned value's `*Touched` flags
  /// are FALSE: prefilling is not touching, and a page the worker passes
  /// through must still send neither key, leaving both stored lists alone.
  /// THROWS a [Failure] on a read failure, for the same reason as
  /// [loadSavedPreferences].
  Future<TradeFormQualifications?> loadSavedQualifications();

  /// PUT the worker's certificates + education rows (the `qualifications`
  /// marker's write) — TRI-STATE per list. [qualifications] owns which keys
  /// are present on the wire (see [TradeFormQualifications.toJson]); the
  /// caller must not invoke this when [TradeFormQualifications.hasAnyTouch]
  /// is false, since an empty body is the endpoint's one deliberate 400.
  Future<void> saveQualifications(TradeFormQualifications qualifications);
}
