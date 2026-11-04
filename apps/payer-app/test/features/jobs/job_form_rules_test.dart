import 'package:flutter_test/flutter_test.dart';

import 'package:payer_app/features/jobs/domain/worker_card_fields.dart';
import 'package:payer_app/features/jobs/presentation/widgets/job_content_input.dart';
import 'package:payer_app/features/jobs/presentation/widgets/job_form_rules.dart';

/// #2595 (M7) — the posting forms show EVERY reason a post/save is refused,
/// each AT its control. These pin the shared rules behind that: every
/// worker-card gap with the control it points at (payer-web's
/// `workerCardGaps`), and the combined inline-error map the three forms use.
void main() {
  /// A card-complete form; override one field to open a gap.
  Map<JobFormField, String> errorsFor({
    String city = 'Pune',
    int? payMin = 18000,
    int? payMax = 24000,
    String? payType = 'in_hand',
    int? expMin = 1,
    int? expMax = 4,
    String? shift = 'day',
    String? neededBy = 'soon',
    String description = 'Turning work on Fanuc controls.',
    List<String> requirements = const <String>['ITI fitter'],
    List<String> benefits = const <String>['PF + ESI'],
  }) =>
      jobContentErrors(
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

  group('workerCardGaps — every gap, in reading order, at its control', () {
    test('an empty form lists every card field', () {
      final List<WorkerCardGap> gaps = workerCardGaps(
        city: ' ',
        payMin: null,
        payMax: null,
        payType: null,
        expMin: null,
        expMax: null,
        shift: null,
        neededBy: null,
        description: '',
        requirements: const <String>[],
        benefits: const <String>[],
      );
      expect(
        gaps.map((WorkerCardGap g) => g.field).toList(),
        <WorkerCardField>[
          WorkerCardField.city,
          WorkerCardField.payMin,
          WorkerCardField.payType,
          WorkerCardField.expMin,
          WorkerCardField.shift,
          WorkerCardField.neededBy,
          WorkerCardField.description,
          WorkerCardField.requirements,
          WorkerCardField.benefits,
        ],
      );
      expect(gaps.first.title, 'Add the city');
      // workerCardGap is still the FIRST of them.
      expect(
        workerCardGap(
          city: '',
          payMin: null,
          payMax: null,
          payType: null,
          expMin: null,
          expMax: null,
          shift: null,
          neededBy: null,
          description: '',
          requirements: const <String>[],
          benefits: const <String>[],
        ),
        gaps.first,
      );
    });

    test('a half-filled pair points at the end that is missing', () {
      final List<WorkerCardGap> gaps = workerCardGaps(
        city: 'Pune',
        payMin: 18000,
        payMax: null,
        payType: 'gross',
        expMin: 1,
        expMax: null,
        shift: 'day',
        neededBy: 'soon',
        description: 'Fitting.',
        requirements: const <String>['ITI'],
        benefits: const <String>['PF'],
      );
      expect(
        gaps.map((WorkerCardGap g) => g.field).toList(),
        <WorkerCardField>[WorkerCardField.payMax, WorkerCardField.expMax],
      );
    });
  });

  group('jobContentErrors — the inline errors the three forms share', () {
    test('a complete form has none', () {
      expect(errorsFor(), isEmpty);
    });

    test('each gap is its short title, at its control', () {
      expect(errorsFor(city: ''), <JobFormField, String>{
        JobFormField.city: 'Add the city',
      });
      expect(errorsFor(payType: null), <JobFormField, String>{
        JobFormField.payType: 'Pick the pay type',
      });
      expect(errorsFor(benefits: const <String>[]), <JobFormField, String>{
        JobFormField.benefits: 'Add a benefit',
      });
      expect(
        errorsFor(payMin: null, shift: null, requirements: const <String>[]),
        <JobFormField, String>{
          JobFormField.payMin: 'Add the pay band',
          JobFormField.shift: 'Pick the shift',
          JobFormField.requirements: 'Add a requirement',
        },
      );
    });

    test('a reversed band is refused at its max box — both bands at once', () {
      expect(
        errorsFor(payMin: 30000, payMax: 20000, expMin: 5, expMax: 2),
        <JobFormField, String>{
          JobFormField.payMax: kPayBandOrderError,
          JobFormField.expMax: kExperienceOrderError,
        },
      );
    });

    test('a description with contact details is refused at the description',
        () {
      expect(
        errorsFor(description: 'Call 98765 43210 to apply'),
        <JobFormField, String>{
          JobFormField.description: postingDescriptionError(
            'Call 98765 43210 to apply',
          )!,
        },
      );
    });

    test('every worker-card control has a form control', () {
      for (final WorkerCardField field in WorkerCardField.values) {
        expect(jobFormFieldOf(field).name, field.name);
      }
    });
  });

  group('postingPhraseError — the chip-entry screen', () {
    test('too long, or contact details, is refused with the reason', () {
      expect(
        postingPhraseError('x' * 81, noun: 'benefit', maxChars: 80),
        'Keep a benefit under 80 characters.',
      );
      expect(
        postingPhraseError('call 98765 43210', noun: 'skill', maxChars: 80),
        'Leave phone numbers and email addresses out of a posting.',
      );
      expect(postingPhraseError('PF + ESI', noun: 'benefit', maxChars: 80),
          isNull);
    });
  });
}
