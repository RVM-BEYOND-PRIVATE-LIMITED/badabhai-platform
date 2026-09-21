import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/features/chat/domain/chat_resume_menu.dart';
import 'package:badabhai_worker_app/features/trade_form/domain/trade_form_models.dart';
import 'package:badabhai_worker_app/features/trade_form/presentation/trade_form_section_walk.dart';
import 'package:badabhai_worker_app/features/voice_form/domain/voice_form_models.dart';

/// ── THE TECHNICAL SKILLS SECTION WALK (post-completion edit pilot) ──────────
///
/// The filter is the whole feature: which form steps re-ask for one résumé
/// section. Everything downstream (cubit narrowing, chat routing) trusts it,
// so the rule itself is pinned here key-by-key.
VoiceQuestion _q(String id) => VoiceQuestion(
      id: id,
      prompt: 'Sawaal $id',
      kind: VoiceQuestionKind.multiSelect,
      options: const <VoiceChoice>[VoiceChoice(key: 'k', label: 'L')],
    );

TradeFormQuestionStep _step(String id) =>
    TradeFormQuestionStep(question: _q(id), searchable: false);

void main() {
  group('tradeFormSectionFilterFor', () {
    test('null and unknown section keys mean the full walk', () {
      expect(tradeFormSectionFilterFor(null), isNull);
      expect(tradeFormSectionFilterFor('section_general_info'), isNull);
      expect(tradeFormSectionFilterFor('nope'), isNull);
    });

    test('the pilot key is the server key, never a second spelling', () {
      expect(kResumeMenuTechnicalSkillsKey, 'section_technical_skills');
      expect(tradeFormSectionFilterFor(kResumeMenuTechnicalSkillsKey),
          isNotNull);
    });
  });

  group('Technical Skills keeps craft capability', () {
    const List<String> kept = <String>[
      'turning_machine', // Machines
      'controller_brand', // Machines (controller)
      'axis_capability', // Machine capability
      'turning_operation', // Operations
      'workholding', // Tooling & fixtures
      'material_worked', // Material
      'measuring_tools', // Quality & inspection
      'drawing_reading', // Drawing & design
      'cad_software', // Programming & software
      'welding_process', // Process
      'troubleshooting', // Troubleshooting
    ];

    for (final String id in kept) {
      test('$id is asked', () {
        expect(tradeFormSectionFilterFor(kResumeMenuTechnicalSkillsKey)!(_step(id)),
            isTrue);
      });
    }
  });

  group('Technical Skills drops what other sections own', () {
    test('marker pages belong to their own résumé sections', () {
      final TradeFormStepFilter filter =
          tradeFormSectionFilterFor(kResumeMenuTechnicalSkillsKey)!;
      expect(filter(const TradeFormPreferencesStep()), isFalse);
      expect(filter(const TradeFormEmploymentStep()), isFalse);
      expect(filter(const TradeFormQualificationsStep()), isFalse);
    });

    test('Experience feeds General Info, not a skill', () {
      final TradeFormStepFilter filter =
          tradeFormSectionFilterFor(kResumeMenuTechnicalSkillsKey)!;
      expect(filter(_step('turning_experience')), isFalse);
      expect(filter(_step('machining_level')), isFalse);
    });

    test('Industry feeds General Info', () {
      final TradeFormStepFilter filter =
          tradeFormSectionFilterFor(kResumeMenuTechnicalSkillsKey)!;
      expect(filter(_step('sector_worked')), isFalse);
    });

    test('Training feeds Education & Certifications', () {
      final TradeFormStepFilter filter =
          tradeFormSectionFilterFor(kResumeMenuTechnicalSkillsKey)!;
      expect(filter(_step('iti_project_work')), isFalse);
      expect(filter(_step('trade_test_status')), isFalse);
    });

    test('an unknown key fails OPEN — never silently dropped', () {
      final TradeFormStepFilter filter =
          tradeFormSectionFilterFor(kResumeMenuTechnicalSkillsKey)!;
      expect(filter(_step('some_future_pack_question')), isTrue);
    });
  });
}
