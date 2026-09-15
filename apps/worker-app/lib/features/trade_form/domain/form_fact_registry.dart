import 'package:flutter/foundation.dart' show debugPrint;

import '../../../core/session/known_worker_facts_store.dart' show WorkerFact;
import 'trade_form_models.dart';

export '../../../core/session/known_worker_facts_store.dart' show WorkerFact;

/// ONE FACT, ASKED ONCE — the client guard that makes a repeated trade-form
/// question impossible, whatever `GET /profiling/form` sends.
///
/// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
///
/// The deployed API (f455bb36) appends every `qp_universal@2` question to the
/// capability section of every trade form: primary_trade, experience_years,
/// current_city, salary_expected, preferred_locations, availability, education
/// and shift_preference. The SAME form then serves the preferences, employment
/// and qualifications marker pages, which own most of those facts. So a worker
/// typed "Aap kahaan kaam karna chahte hain?" into a plain text box and was
/// then asked the same thing again on the preferences page's State → City
/// picker, and the same happened for salary, shift and education. The pack's
/// own tenure question (turning_experience, ...) was asked twice as well, next
/// to experience_years.
///
/// The rule is "ask once, skip if known". A fact the form has a marker page
/// for is asked THERE, a fact the worker already gave (the trade that routed
/// them here always; the city from /name or a chat answer only when one was
/// actually recorded, see [KnownWorkerFactsStore]) is not asked again, and two
/// questions for one fact collapse into one.
///
/// The server-side fix (drop the universal append, one fact registry across
/// chat and form) is tracked separately for Backend. This guard stays useful
/// after it lands: it is a no-op on a form that has no duplicates.
///
/// ── WHAT IT NEVER TOUCHES ───────────────────────────────────────────────────
///
/// A question key this registry does not know — every trade-specific capability
/// question — passes through unchanged. The registry only removes; it never
/// reorders, rewrites or invents a screen.

/// The three marker screens a trade form can carry (`screens[].type`).
enum TradeFormMarkerType { preferences, employment, qualifications }

/// The marker type of [step], or null for a question screen.
TradeFormMarkerType? tradeFormMarkerTypeOf(TradeFormStep step) =>
    switch (step) {
      TradeFormPreferencesStep() => TradeFormMarkerType.preferences,
      TradeFormEmploymentStep() => TradeFormMarkerType.employment,
      TradeFormQualificationsStep() => TradeFormMarkerType.qualifications,
      TradeFormQuestionStep() => null,
    };

/// `question_key` → the fact it asks for. Keys absent here are trade-specific
/// and are never dropped.
const Map<String, WorkerFact> kTradeFormQuestionFacts = <String, WorkerFact>{
  'primary_trade': WorkerFact.trade,
  'current_city': WorkerFact.currentCity,
  'preferred_locations': WorkerFact.preferredCities,
  'salary_expected': WorkerFact.salary,
  'shift_preference': WorkerFact.shift,
  'shift_work': WorkerFact.shift,
  'night_work': WorkerFact.shift,
  'education': WorkerFact.education,
  'relocation': WorkerFact.relocation,
  'relocation_willingness': WorkerFact.relocation,
  'language_spoken': WorkerFact.languages,
  // Tenure: the universal "kitne saal" and each form pack's own tier question.
  'experience_years': WorkerFact.tradeTenure,
  'turning_experience': WorkerFact.tradeTenure,
  'milling_experience': WorkerFact.tradeTenure,
  'grinding_experience': WorkerFact.tradeTenure,
  'toolroom_experience': WorkerFact.tradeTenure,
  'programming_experience': WorkerFact.tradeTenure,
  'drafting_experience': WorkerFact.tradeTenure,
  'machining_experience': WorkerFact.tradeTenure,
  'coating_experience': WorkerFact.tradeTenure,
  'welding_experience': WorkerFact.tradeTenure,
};

/// The suffix every form pack's own tenure question carries
/// (`turning_experience`, `welding_experience`, ...).
const String _kPackTenureKeySuffix = '_experience';

/// The fact [questionKey] asks for, or null for a trade-specific question.
/// A key missing from [kTradeFormQuestionFacts] that ends in
/// [_kPackTenureKeySuffix] is a pack's tenure question too, so a form pack
/// added after this list still has the universal "kitne saal" collapse into
/// its own.
WorkerFact? tradeFormQuestionFact(String questionKey) =>
    kTradeFormQuestionFacts[questionKey] ??
    (questionKey.endsWith(_kPackTenureKeySuffix)
        ? WorkerFact.tradeTenure
        : null);

/// The facts each marker page asks for itself — see
/// `TradeFormPreferencesPage`, `TradeFormEmploymentPage` and
/// `TradeFormQualificationsPage`.
const Map<TradeFormMarkerType, Set<WorkerFact>> kTradeFormMarkerFacts =
    <TradeFormMarkerType, Set<WorkerFact>>{
  TradeFormMarkerType.preferences: <WorkerFact>{
    WorkerFact.preferredCities,
    WorkerFact.salary,
    WorkerFact.shift,
    WorkerFact.relocation,
    WorkerFact.languages,
    WorkerFact.documents,
    WorkerFact.jobType,
    WorkerFact.accommodation,
  },
  TradeFormMarkerType.employment: <WorkerFact>{WorkerFact.workHistory},
  TradeFormMarkerType.qualifications: <WorkerFact>{
    WorkerFact.education,
    WorkerFact.certificates,
  },
};

/// The one fact every worker has given before any trade form opens: the trade
/// (a form exists only because the trade is known). The current city is NOT
/// here: /name lets a worker skip it, so it counts as known only when recorded
/// (see [dedupeTradeForm]'s `knownFacts`).
const Set<WorkerFact> kFactsAskedBeforeTradeForm = <WorkerFact>{
  WorkerFact.trade,
};

/// `qp_universal@2`'s "current city" question. When it survives the guard (the
/// city is not known yet) the question screen renders the same State → City
/// picker /name uses, never a plain text box.
const String kTradeFormCurrentCityQuestionKey = 'current_city';

/// `qp_universal@2`'s tenure question. Every OTHER tenure key in
/// [kTradeFormQuestionFacts] belongs to a form pack and gates that pack's
/// `ask_if` tiers, so only this one is ever dropped for tenure.
const String kUniversalTenureQuestionKey = 'experience_years';

/// Returns [form] with every screen that re-asks a known fact removed:
///
///  * a second marker screen of the same type (the first is kept);
///  * a second question with the same `question_key` (the first is kept);
///  * a question whose fact is owned by a marker present in the form, was
///    given before the form ([kFactsAskedBeforeTradeForm] or [knownFacts]), or
///    is already covered by an earlier kept question;
///  * the universal tenure question whenever the form carries its pack's own
///    tenure question, wherever the two sit (the pack's one is always kept:
///    it gates the pack's tiered questions and counts toward completion);
///  * a section left with no screens by the removals above.
///
/// Returns [form] itself when nothing is removed. Logs the removed question
/// keys and marker types (pack vocabulary, never an answer).
TradeForm dedupeTradeForm(
  TradeForm form, {
  Set<WorkerFact> knownFacts = const <WorkerFact>{},
}) {
  final bool hasPackTenure = form.questionSteps.any(
    (TradeFormQuestionStep q) =>
        q.question.id != kUniversalTenureQuestionKey &&
        tradeFormQuestionFact(q.question.id) == WorkerFact.tradeTenure,
  );
  final Set<WorkerFact> covered = <WorkerFact>{
    ...kFactsAskedBeforeTradeForm,
    ...knownFacts,
    if (hasPackTenure) WorkerFact.tradeTenure,
    for (final TradeFormSection section in form.sections)
      for (final TradeFormStep step in section.screens)
        ...?kTradeFormMarkerFacts[tradeFormMarkerTypeOf(step)],
  };
  final Set<TradeFormMarkerType> seenMarkers = <TradeFormMarkerType>{};
  final Set<String> seenKeys = <String>{};
  final List<String> dropped = <String>[];

  bool keep(TradeFormStep step) {
    if (step is! TradeFormQuestionStep) {
      final TradeFormMarkerType type = tradeFormMarkerTypeOf(step)!;
      if (seenMarkers.add(type)) return true;
      dropped.add('marker:${type.name}');
      return false;
    }
    final String key = step.question.id;
    // An empty key is a malformed row the parser let through; it names no
    // question, so it cannot duplicate one.
    if (key.isNotEmpty && !seenKeys.add(key)) {
      dropped.add(key);
      return false;
    }
    final WorkerFact? fact = tradeFormQuestionFact(key);
    // A pack's own tenure question is never dropped (see the doc above).
    final bool packTenure = fact == WorkerFact.tradeTenure &&
        key != kUniversalTenureQuestionKey;
    if (packTenure) return true;
    if (fact != null && !covered.add(fact)) {
      dropped.add(key);
      return false;
    }
    return true;
  }

  final List<TradeFormSection> sections = <TradeFormSection>[];
  for (final TradeFormSection section in form.sections) {
    final List<TradeFormStep> screens = section.screens.where(keep).toList();
    if (screens.length == section.screens.length) {
      sections.add(section);
    } else if (screens.isNotEmpty) {
      sections.add(TradeFormSection(
        id: section.id,
        title: section.title,
        screens: screens,
      ));
    }
  }

  if (dropped.isEmpty) return form;
  debugPrint('[TradeForm] skipped already-asked screens: ${dropped.join(', ')}');
  return TradeForm(
    kind: form.kind,
    packId: form.packId,
    packVersion: form.packVersion,
    sessionId: form.sessionId,
    sections: sections,
  );
}
