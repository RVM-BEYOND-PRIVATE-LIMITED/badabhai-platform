import '../../domain/worker_card_fields.dart';
import 'job_content_input.dart';

/// The controls of the posting forms — Post a job and both Edit screens — an
/// inline error can point at, and a keyboard chain can visit (#2595).
enum JobFormField {
  org,
  tradeKey,
  role,
  title,
  location,
  city,
  area,
  payMin,
  payMax,
  payType,
  expMin,
  expMax,
  shift,
  neededBy,
  skills,
  description,
  benefits,
  requirements,
}

/// The form control a worker-card gap is shown at.
JobFormField jobFormFieldOf(WorkerCardField field) => switch (field) {
      WorkerCardField.city => JobFormField.city,
      WorkerCardField.payMin => JobFormField.payMin,
      WorkerCardField.payMax => JobFormField.payMax,
      WorkerCardField.payType => JobFormField.payType,
      WorkerCardField.expMin => JobFormField.expMin,
      WorkerCardField.expMax => JobFormField.expMax,
      WorkerCardField.shift => JobFormField.shift,
      WorkerCardField.neededBy => JobFormField.neededBy,
      WorkerCardField.description => JobFormField.description,
      WorkerCardField.requirements => JobFormField.requirements,
      WorkerCardField.benefits => JobFormField.benefits,
    };

/// The inline errors for "Max pay" below "Min pay" and its experience twin.
const String kPayBandOrderError = 'Max pay must be at least the min.';
const String kExperienceOrderError = 'Max experience must be at least the min.';

/// The worker-visible half every posting form insists on, as inline errors AT
/// their controls (#2595) — one copy for the three forms:
///  - each worker-card gap ([workerCardGaps]), shown as its short title
///    ("Add the city");
///  - the min/max ordering the server 400s, at the max box;
///  - the description screen (length cap + contact details), at the
///    description.
///
/// The server stays the authority on every one of these; this only fails
/// closed EARLIER, with the reason at the field instead of a toast.
Map<JobFormField, String> jobContentErrors({
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
  final Map<JobFormField, String> errors = <JobFormField, String>{
    for (final WorkerCardGap gap in workerCardGaps(
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
    ))
      jobFormFieldOf(gap.field): gap.title,
  };
  if (payMin != null && payMax != null && payMax < payMin) {
    errors[JobFormField.payMax] = kPayBandOrderError;
  }
  if (expMin != null && expMax != null && expMax < expMin) {
    errors[JobFormField.expMax] = kExperienceOrderError;
  }
  final String? descriptionError = postingDescriptionError(description);
  if (descriptionError != null) {
    errors[JobFormField.description] = descriptionError;
  }
  return errors;
}

// --- "Has the payer changed anything?" (#2595) -----------------------------
// The leave guard compares a form's values with what it opened on. These turn
// the collection-valued ones into comparable strings, so a snapshot is a flat
// list that `listEquals` can compare (a List compares by identity otherwise).

/// A chip list, in order (the order rides the PATCH).
String listSnapshotKey(List<String> values) => values.join('\u0000');

/// A set of ids — order-insensitive.
String setSnapshotKey(Iterable<String> values) =>
    (values.toList()..sort()).join('\u0000');

/// The trade answer map — question keys and each answer list order-
/// insensitive, so a re-tap in another order is not a change.
String tradeAnswersSnapshotKey(Map<String, List<String>> answers) =>
    (answers.entries
            .map((MapEntry<String, List<String>> e) =>
                '${e.key}=${setSnapshotKey(e.value)}')
            .toList()
          ..sort())
        .join('\u0001');
