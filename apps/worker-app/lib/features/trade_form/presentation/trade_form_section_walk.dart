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
/// PILOT: Technical Skills only. Every other section key (and a null key)
/// yields a null filter, and the caller walks the whole form exactly as
/// today — so expanding to the next section is a new predicate here plus one
/// routing branch in the chat screen, never a change to the cubit, the
/// screen, or the router.
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
/// Categories come from [formTopicFor] — the SAME function the form header
/// renders — so the filter can never disagree with what the worker sees.
/// Unknown question keys fail OPEN (included): [formTopicFor] falls back to
/// readable words for a key no shipped pack names, and excluding an
/// unrecognized question would silently drop it from every section walk.
library;

import '../../chat/domain/chat_resume_menu.dart'
    show kResumeMenuTechnicalSkillsKey;
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
  final String category = formTopicFor(step.question.id).$1;
  return !_kNonSkillCategories.contains(category);
}

/// The filter for a résumé-section walk, or null for the full walk.
///
/// Returns non-null ONLY for the piloted section ([kResumeMenuTechnicalSkillsKey],
/// the server's key in `apps/api/src/chat/resume-menu.ts`, pinned byte-for-byte
/// by the chat parity test). Every other key — including null — yields null,
/// and the caller walks the whole form exactly as today.
TradeFormStepFilter? tradeFormSectionFilterFor(String? sectionKey) {
  if (sectionKey == kResumeMenuTechnicalSkillsKey) {
    return _isTechnicalSkillsStep;
  }
  return null;
}
