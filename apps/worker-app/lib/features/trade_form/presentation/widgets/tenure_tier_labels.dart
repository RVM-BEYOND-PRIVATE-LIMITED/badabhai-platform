import '../../domain/form_fact_registry.dart'
    show WorkerFact, tradeFormQuestionFact;

/// How a tenure option is DRAWN — never what it means.
///
/// Every trade pack asks its tenure question with the same four option keys
/// (`under_one`, `one_to_three`, `three_to_seven`, `over_seven`) and labels them
/// in years ("1 se 3 saal"). The owner's screen 8 draws those same four rungs as
/// CAREER TIERS instead, because a worker recognises "Junior Operator" faster
/// than a year band, and the screenshot is the design of record.
///
/// DISPLAY ONLY. The option KEY the card submits, the pack's `value_number`
/// (0/2/5/10) that gates how many questions follow, the icon (derived from the
/// server's own words) and every saved answer are untouched: this file maps a
/// key to a title and a line of help text, nothing else. An option key that is
/// not one of the four rungs — e.g. CAD drafting's extra `fresher_course` — has
/// no entry and keeps the server's own label, so a pack that adds a rung is
/// never mislabelled by a stale client table.
class TenureTierLabel {
  const TenureTierLabel(this.title, this.description);

  final String title;

  /// The parenthesised second line under the title, as the screenshot draws it.
  final String description;
}

/// The four rungs, in pack order.
const Map<String, TenureTierLabel> kTenureTierLabels = <String, TenureTierLabel>{
  'under_one': TenureTierLabel(
    'Fresher / Trainee',
    '(Bilkul naya ya ITI pass)',
  ),
  'one_to_three': TenureTierLabel(
    'Junior Operator',
    '(Basic machine setting & operations)',
  ),
  'three_to_seven': TenureTierLabel(
    'Mid-Level Specialist',
    '(Independent setting & tool offset handle karna)',
  ),
  'over_seven': TenureTierLabel(
    'Senior Master / Incharge',
    '(Master programming, maintenance & supervisor)',
  ),
};

/// The tier drawing for [optionKey], or null when this question is not a
/// tenure question or the key is not one of the four rungs.
///
/// The question is recognised through the SAME registry the de-dup guard uses
/// (`tradeFormQuestionFact`), so every trade's `*_experience` question is
/// covered — turning, milling, grinding, toolroom, programming, drafting,
/// machining, coating, welding — and nothing else can be relabelled by
/// accident.
TenureTierLabel? tenureTierLabelFor({
  required String questionKey,
  required String optionKey,
}) {
  if (tradeFormQuestionFact(questionKey) != WorkerFact.tradeTenure) return null;
  return kTenureTierLabels[optionKey];
}
