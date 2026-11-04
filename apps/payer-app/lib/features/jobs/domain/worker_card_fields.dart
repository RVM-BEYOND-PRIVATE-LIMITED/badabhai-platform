/// EVERY FACT THE WORKER'S JOB CARD SHOWS, IN ONE PLACE.
///
/// The worker app's job card (`BbJobCardData`, rendered by `design1_job_card`
/// on the Jobs deck and `bb_job_card` in the lists) draws exactly these:
///
///   * the role title,
///   * the place — `city`, plus the optional `area` beside it,
///   * the ₹ band (`pay_min`–`pay_max`) and what that band MEANS (`pay_type`),
///   * the experience window (`min/max_experience_years`),
///   * the shift, and the needed-by chip,
///   * the description, and
///   * the requirement + benefit chip rows.
///
/// Every one of them used to be optional on the payer forms, and an unstated
/// field is a HOLE on the card, not a tidy omission: no city means the feed
/// serves `""` and the card draws a location pin with nothing beside it; no
/// pay type means a band with no answer to "kitna haath me aayega".
///
/// So the forms insist on all of them — the company create, the agency create
/// and BOTH edit screens — and they do it through this ONE function, because
/// four copies of the rule would drift the moment the card gained a row.
///
/// What is deliberately NOT here:
///   * `area` — the optional second half of the place line; the card renders
///     the city alone perfectly well.
///   * the company form's free-text Location note (`location_label`) — the
///     worker feed never reads it.
///   * `vacancy_band` — the payer states it, but no worker-facing route serves
///     it, so requiring it here would not put it on a card.
library;

/// The control on a posting form a [WorkerCardGap] points at — where its
/// inline error is shown. For a min/max pair it is the end actually missing.
enum WorkerCardField {
  city,
  payMin,
  payMax,
  payType,
  expMin,
  expMax,
  shift,
  neededBy,
  description,
  requirements,
  benefits,
}

/// A single missing field: the control to fix ([field]), a short imperative
/// [title] (the inline error at that control) and the [message] saying why
/// the card needs it.
typedef WorkerCardGap = ({
  WorkerCardField field,
  String title,
  String message,
});

/// The FIRST field the card needs and the form does not have, or null when the
/// card can be drawn in full.
///
/// Ordered as the forms are read, top to bottom, so the message always names
/// the field nearest the payer's eye rather than the last one checked.
///
/// [city], [description] are the raw box contents (trimmed here). The enums are
/// null until picked. The chip lists are the editor's current contents.
WorkerCardGap? workerCardGap({
  required String city,
  required int? payMin,
  required int? payMax,
  required String? payType,
  required int? expMin,
  required int? expMax,
  required String? shift,
  required String? neededBy,
  required String description,
  required List<String> requirements,
  required List<String> benefits,
}) {
  final List<WorkerCardGap> gaps = workerCardGaps(
    city: city,
    payMin: payMin,
    payMax: payMax,
    payType: payType,
    expMin: expMin,
    expMax: expMax,
    shift: shift,
    neededBy: neededBy,
    description: description,
    requirements: requirements,
    benefits: benefits,
  );
  return gaps.isEmpty ? null : gaps.first;
}

/// EVERY field the card needs and the form does not have, in the same top-to-
/// bottom order (#2595) — so a refused post shows each one inline at once,
/// instead of naming one and making the payer discover the next only after
/// fixing it (payer-web's `workerCardGaps`, same reason).
List<WorkerCardGap> workerCardGaps({
  required String city,
  required int? payMin,
  required int? payMax,
  required String? payType,
  required int? expMin,
  required int? expMax,
  required String? shift,
  required String? neededBy,
  required String description,
  required List<String> requirements,
  required List<String> benefits,
}) {
  return <WorkerCardGap>[
    if (city.trim().isEmpty)
      (
        field: WorkerCardField.city,
        title: 'Add the city',
        message: 'The city is the place shown on the worker\'s card. Without '
            'it the card shows a location pin with nothing beside it.',
      ),
    if (payMin == null || payMax == null)
      (
        field: payMin == null ? WorkerCardField.payMin : WorkerCardField.payMax,
        title: 'Add the pay band',
        message: 'Both ends of the ₹ band are shown on the card — "kitna '
            'milega" is the first thing a worker looks at.',
      ),
    if (payType == null)
      (
        field: WorkerCardField.payType,
        title: 'Pick the pay type',
        message: 'Say what the band means — in-hand, gross or CTC. We never '
            'guess it for you.',
      ),
    if (expMin == null || expMax == null)
      (
        field: expMin == null ? WorkerCardField.expMin : WorkerCardField.expMax,
        title: 'Add the experience',
        message: 'The card shows an experience window. Fill both the min and '
            'the max years.',
      ),
    if (shift == null)
      (
        field: WorkerCardField.shift,
        title: 'Pick the shift',
        message: 'Day, night or rotational — the card shows it as a chip.',
      ),
    if (neededBy == null)
      (
        field: WorkerCardField.neededBy,
        title: 'Pick needed by',
        message: 'When you need someone. The card shows it as a chip.',
      ),
    if (description.trim().isEmpty)
      (
        field: WorkerCardField.description,
        title: 'Add the description',
        // Aligned with payer-web's worker-card-gap copy (#1888): the swipe card
        // does NOT show the description — workers read it when they open the
        // job.
        message: 'Workers read it when they open the job — it is not on the '
            'swipe card. Say what the work is.',
      ),
    if (requirements.isEmpty)
      (
        field: WorkerCardField.requirements,
        title: 'Add a requirement',
        message: 'At least one requirement chip — the card has a row for them.',
      ),
    if (benefits.isEmpty)
      (
        field: WorkerCardField.benefits,
        title: 'Add a benefit',
        message: 'At least one benefit chip — the card has a row for them.',
      ),
  ];
}
