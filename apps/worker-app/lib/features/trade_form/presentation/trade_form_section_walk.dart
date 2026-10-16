/// A section-filtered trade-form walk (post-completion résumé edit pilot).
///
/// The Bada Bhai menu serves six résumé sections, but the trade form is
/// organized by TRADE TOPIC, not by résumé section (`GET /profiling/form`
/// returns the whole form in server order). This file is the one place that
/// maps a résumé-section key onto the subset of form steps that feed it, so
/// the worker re-answers only that section's questions on the EXISTING form
/// pages — no new screens, no new save path. It works on domain [TradeFormStep]
/// (never on the cubit's flattened wrapper) so the dependency runs toward the
/// domain, never back into presentation state.
///
/// PILOT: Technical Skills + Availability, Terms & Salary + Work History +
/// Education & Certifications.
/// Every other section key (and a null key) yields a null filter, and the
/// caller walks the whole form exactly as today — so expanding to the next
/// section is a new predicate here plus one routing branch in the chat
/// screen, never a change to the cubit, the screen, or the router.
///
/// THE RULE (Technical Skills = craft capability, nothing else). The résumé's
/// Technical Skills section prints the `Machines` + `Skills` labels, which the
/// pipeline derives from the capability answers — every pack question EXCEPT:
///   - marker pages (`preferences` / `employment` / `qualifications`), which
///     belong to the Location / Work History / Education résumé sections and
///     already have their own pages and save endpoints;
///   - `Experience`-category questions (tenure/level), which feed General
///     Info's `Experience`, not a skill;
///   - `Industry`-category questions (sector), which feed General Info;
///   - `Training`-category questions (ITI project / trade test), which feed
///     Education & Certifications.
///
/// Categories come from the SAME table the form header renders
/// (`trade_form_topics.dart`), so the filter can never disagree with what the
/// worker sees — but through [knownFormTopicFor], never through
/// [formTopicFor]'s readable-words display fallback.
///
/// UNKNOWN QUESTION KEYS FAIL CLOSED (dropped from a section walk). This was
/// fail-OPEN until 2026-10-16, and the open failure is exactly how it broke:
/// the seven form trades shipped 2026-09-24/25 carried 68 keys the table did
/// not name, each fell back to its own words — a "category" that is never
/// `Experience` — and so every one of them, the tenure and self-level
/// questions included, was asked again under Technical Skills. An unknown key
/// is now left out of the section walk (it stays on the full walk), and
/// `trade_form_topics_coverage_test.dart` reads the shipped packs so that a
/// form pack carrying an unmapped key turns CI red instead of quietly
/// shrinking or bloating a walk.
library;

import '../../chat/domain/chat_resume_menu.dart'
    show
        kResumeMenuAvailabilitySalaryKey,
        kResumeMenuEducationKey,
        kResumeMenuTechnicalSkillsKey,
        kResumeMenuWorkHistoryKey;
import '../domain/trade_form_models.dart';
import 'widgets/trade_form_topics.dart';

/// Keep or drop one form step for a section walk.
typedef TradeFormStepFilter = bool Function(TradeFormStep step);

/// Categories that do NOT feed Technical Skills (see the file doc).
const Set<String> _kNonSkillCategories = <String>{
  'Experience',
  'Industry',
  'Training',
};

/// Whether [step] belongs in the Technical Skills walk.
bool _isTechnicalSkillsStep(TradeFormStep step) {
  if (step is! TradeFormQuestionStep) return false; // a marker page
  final (String, String)? topic = knownFormTopicFor(step.question.id);
  if (topic == null) return false; // unknown key — fail closed (file doc)
  return !_kNonSkillCategories.contains(topic.$1);
}

/// Whether [step] belongs in the Availability, Terms & Salary walk.
///
/// The résumé's "Availability, Terms & Salary" section prints the worker's
/// job preferences — shift, job type, preferred cities, relocate +
/// accommodation, and the expected-salary band — which the pipeline derives
/// from the `preferences` marker answers (`PUT /workers/me/work-preferences`).
/// The walk is therefore exactly that ONE marker step on the EXISTING form
/// pages: no capability questions, no employment, no qualifications. The
/// marker's own INTERNAL pages are narrowed separately — languages and
/// documents belong to other résumé sections and are hidden there (see
/// `TradeFormPreferencesPage.sectionKey`) — so this predicate stays at step
/// granularity, like the Technical Skills one above.
bool _isAvailabilitySalaryStep(TradeFormStep step) =>
    step is TradeFormPreferencesStep;

/// Whether [step] belongs in the Work History walk.
///
/// The résumé's Work History section prints the worker's employment entries —
/// employer, role, dates and tenure — which the pipeline derives from the
/// `employment` marker answers (`PUT /workers/me/employment`, whole-history
/// replace). The walk is therefore exactly that ONE marker step on the
/// EXISTING form page: no capability questions, no preferences, no
/// qualifications. The page has no internal pages to narrow (unlike the
/// preferences marker), so this predicate stays at step granularity and the
/// cubit reads the stored history through the SAME `loadSavedEmployment`
/// prefill (#1710) with no screen change.
bool _isWorkHistoryStep(TradeFormStep step) => step is TradeFormEmploymentStep;

/// Whether [step] belongs in the Education & Certifications walk.
///
/// The résumé's Education & Certifications section prints the worker's
/// education entries + certificates, which the pipeline derives from the
/// `qualifications` marker answers (`PUT /workers/me/qualifications`,
/// tri-state). The walk is therefore exactly that ONE marker step on the
/// EXISTING form page: no capability questions, no preferences, no
/// employment.
///
/// DELIBERATELY MARKER-ONLY. The Training-category pack questions
/// (`iti_project_work`, `trade_test_status`, …) also feed this section on the
/// résumé, but a marker + questions combined walk strands the done marker: the
/// cubit's forward moves skip saved markers, so with everything answered the
/// walk lands on the last question and the marker (the whole point of the
/// walk) is never shown. A marker-only single-step walk always lands on its
/// step (same as Availability / Work History). Training questions stay
/// reachable via the full walk; combining them is a later enhancement that
/// needs cubit semantics, not a predicate.
///
/// The marker's own INTERNAL hide (`certificates` on Easy) is overridden
/// separately by the page's `sectionKey` (#2220's lesson) — this predicate
/// stays at step granularity.
bool _isEducationStep(TradeFormStep step) =>
    step is TradeFormQualificationsStep;

/// The filter for a résumé-section walk, or null for the full walk.
///
/// Returns non-null ONLY for the piloted sections ([kResumeMenuTechnicalSkillsKey],
/// [kResumeMenuAvailabilitySalaryKey], [kResumeMenuWorkHistoryKey] and
/// [kResumeMenuEducationKey], the server's keys in
/// `apps/api/src/chat/resume-menu.ts`, pinned byte-for-byte by the chat parity
/// test). Every other key — including null — yields null, and the caller walks
/// the whole form exactly as today.
TradeFormStepFilter? tradeFormSectionFilterFor(String? sectionKey) {
  if (sectionKey == kResumeMenuTechnicalSkillsKey) {
    return _isTechnicalSkillsStep;
  }
  if (sectionKey == kResumeMenuAvailabilitySalaryKey) {
    return _isAvailabilitySalaryStep;
  }
  if (sectionKey == kResumeMenuWorkHistoryKey) {
    return _isWorkHistoryStep;
  }
  if (sectionKey == kResumeMenuEducationKey) {
    return _isEducationStep;
  }
  return null;
}
