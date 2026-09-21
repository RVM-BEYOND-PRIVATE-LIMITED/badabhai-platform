import 'package:badabhai_worker_app/features/trade_form/presentation/widgets/tenure_tier_labels.dart';
import 'package:flutter_test/flutter_test.dart';

/// The tenure question is drawn as career tiers (owner screen 8) while the
/// option KEY — the only thing the server sees, and the thing its
/// `value_number` gate reads — stays exactly as the pack authored it.
void main() {
  group('tenure tier labels are a drawing, not a meaning', () {
    // Every one of the nine form packs asks its tenure question with these
    // four keys, so one table covers turning, milling, grinding, toolroom,
    // programming, drafting, machining, coating and welding.
    const List<String> tenureQuestions = <String>[
      'turning_experience',
      'milling_experience',
      'grinding_experience',
      'toolroom_experience',
      'programming_experience',
      'drafting_experience',
      'machining_experience',
      'coating_experience',
      'welding_experience',
    ];

    test('the four rungs get the four tiers, in every trade', () {
      for (final String q in tenureQuestions) {
        expect(tenureTierLabelFor(questionKey: q, optionKey: 'under_one')!.title,
            'Fresher / Trainee');
        expect(
            tenureTierLabelFor(questionKey: q, optionKey: 'one_to_three')!.title,
            'Junior Operator');
        expect(
            tenureTierLabelFor(questionKey: q, optionKey: 'three_to_seven')!
                .title,
            'Mid-Level Specialist');
        expect(
            tenureTierLabelFor(questionKey: q, optionKey: 'over_seven')!.title,
            'Senior Master / Incharge');
      }
    });

    test('each tier carries the screenshot help line', () {
      expect(
        tenureTierLabelFor(questionKey: 'turning_experience', optionKey: 'under_one')!
            .description,
        '(Bilkul naya ya ITI pass)',
      );
      expect(
        tenureTierLabelFor(
                questionKey: 'welding_experience', optionKey: 'over_seven')!
            .description,
        '(Master programming, maintenance & supervisor)',
      );
    });

    test('a key the pack adds later keeps the server label', () {
      // CAD drafting really does carry a fifth rung, `fresher_course`.
      expect(
        tenureTierLabelFor(
            questionKey: 'drafting_experience', optionKey: 'fresher_course'),
        isNull,
      );
    });

    test('no other question can be relabelled', () {
      for (final String key in <String>[
        'turning_machine',
        'material_worked',
        'measuring_tools',
        'education',
        'shift_preference',
        'iti_project_work',
      ]) {
        expect(tenureTierLabelFor(questionKey: key, optionKey: 'one_to_three'),
            isNull,
            reason: '$key is not a tenure question');
      }
    });

    test('the table holds exactly the four pack rungs', () {
      expect(kTenureTierLabels.keys.toList(),
          <String>['under_one', 'one_to_three', 'three_to_seven', 'over_seven']);
    });
  });
}
