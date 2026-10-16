import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/features/chat/domain/chat_resume_menu.dart';
import 'package:badabhai_worker_app/features/trade_form/domain/trade_form_models.dart';
import 'package:badabhai_worker_app/features/trade_form/presentation/trade_form_section_walk.dart';
import 'package:badabhai_worker_app/features/trade_form/presentation/widgets/trade_form_topics.dart';
import 'package:badabhai_worker_app/features/voice_form/domain/voice_form_models.dart';

import 'form_pack_corpus.dart';

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

    test('the pilot keys are the server keys, never a second spelling', () {
      expect(kResumeMenuTechnicalSkillsKey, 'section_technical_skills');
      expect(kResumeMenuAvailabilitySalaryKey, 'section_availability_salary');
      expect(kResumeMenuWorkHistoryKey, 'section_work_history');
      expect(kResumeMenuEducationKey, 'section_education');
      expect(tradeFormSectionFilterFor(kResumeMenuTechnicalSkillsKey),
          isNotNull);
      expect(tradeFormSectionFilterFor(kResumeMenuAvailabilitySalaryKey),
          isNotNull);
      expect(tradeFormSectionFilterFor(kResumeMenuWorkHistoryKey), isNotNull);
      expect(tradeFormSectionFilterFor(kResumeMenuEducationKey), isNotNull);
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

    // INVERTED 2026-10-16, deliberately (owner-approved). This test used to
    // pin fail-OPEN ("never silently dropped"), and fail-open is the bug: the
    // seven form trades shipped 2026-09-24/25 carried 68 keys the topics
    // table did not name, and every one of them — tenure and self-level
    // questions included — was re-asked under Technical Skills. An unknown key
    // is now left out of the section walk; what stops a real question going
    // missing that way is `trade_form_topics_coverage_test.dart`, which turns
    // CI red when a shipped form pack carries a key the table does not know.
    test('an unknown key fails CLOSED — left out of the section walk', () {
      final TradeFormStepFilter filter =
          tradeFormSectionFilterFor(kResumeMenuTechnicalSkillsKey)!;
      expect(filter(_step('some_future_pack_question')), isFalse);
    });

    test('an unknown key still has a readable header — display is unchanged',
        () {
      expect(knownFormTopicFor('some_future_pack_question'), isNull);
      expect(formTopicFor('some_future_pack_question'),
          ('Some future pack question', 'Some future pack question'));
    });
  });

  // ── PARITY PIN: the Technical Skills walk of every shipped form trade ────
  //
  // Built from the REAL packs (`form_pack_corpus.dart`), pack order, before any
  // tier or `ask_if` narrowing (the server does that). The nine Batch-1 trades
  // are byte-identical to the fail-open walk they had before 2026-10-16 —
  // every one of their keys was already mapped. The seven Batch-2 trades are
  // the fix: their tenure (`*_experience`) and self-level (`*_level`)
  // questions leave, exactly as the machining ones always did; every
  // capability question stays.
  group('Technical Skills, trade by trade (parity pin)', () {
    const Map<String, List<String>> expected = <String, List<String>>{
      // ── Batch 1 — unchanged ──
      'qp_cnc_turning': <String>[
        'turning_machine', 'controller_brand', 'turning_operation',
        'workholding', 'material_worked', 'measuring_tools', 'drawing_reading',
        'setting_operation', 'tolerance_band', 'programming_level',
        'advanced_capability', 'quality_work', 'troubleshooting',
        'iti_workshop_machines',
      ],
      'qp_vmc_milling': <String>[
        'milling_machine', 'axis_capability', 'controller_brand',
        'milling_operation', 'material_worked', 'measuring_tools',
        'drawing_reading', 'setting_operation', 'tolerance_band',
        'programming_level', 'workholding', 'quality_work', 'troubleshooting',
        'iti_workshop_machines',
      ],
      'qp_cnc_grinding': <String>[
        'grinding_machine', 'grinding_type', 'controller_brand',
        'material_worked', 'wheel_type', 'measuring_tools', 'drawing_reading',
        'setting_work', 'tolerance_band', 'surface_finish', 'dressing_method',
        'quality_work', 'troubleshooting', 'iti_workshop_machines',
      ],
      'qp_conventional_machining': <String>[
        'machining_machine', 'machining_operation', 'material_worked',
        'measuring_tools', 'drawing_reading', 'turning_capacity',
        'tolerance_band', 'setting_operation', 'quality_work',
        'troubleshooting', 'tool_grinding', 'advanced_work',
        'iti_workshop_machines',
      ],
      'qp_tool_die_making': <String>[
        'tooling_made', 'toolroom_machine', 'tool_steel', 'toolroom_work',
        'measuring_tools', 'drawing_reading', 'tolerance_band', 'edm_work',
        'die_design_work', 'die_troubleshooting', 'heat_treatment_work',
        'press_tonnage', 'iti_workshop_machines',
      ],
      'qp_cam_programming': <String>[
        'programming_mode', 'cam_software', 'machine_programmed',
        'controller_brand', 'programming_work', 'drawing_reading',
        'cad_model_handling', 'post_processor_work', 'simulation_work',
        'iti_workshop_machines',
      ],
      'qp_cad_drafting': <String>[
        'cad_software', 'cad_modules', 'drawing_work', 'drawing_standards',
        'drawing_type', 'output_produced', 'design_input_source',
        'measuring_tools', 'drawing_check_work', 'design_work',
        'iti_workshop_machines',
      ],
      'qp_welding_trade': <String>[
        'welding_process', 'welding_equipment', 'electrode_type',
        'material_worked', 'welding_position', 'drawing_reading',
        'plate_thickness', 'inspection_work', 'joint_type', 'machine_setting',
        'weld_defect', 'fabrication_work', 'iti_workshop_machines',
      ],
      'qp_powder_coating': <String>[
        'coating_process', 'coating_equipment', 'coating_material',
        'surface_prep', 'coating_checks', 'booth_type', 'film_thickness',
        'substrate_worked', 'gun_setting', 'oven_schedule', 'coating_defects',
        'colour_change', 'iti_workshop_machines',
      ],
      // ── Batch 2 — tenure + self-level leave; capability stays ──
      'qp_sheet_metal_fab': <String>[
        'sheet_metal_machine', 'material_worked', 'sheet_operation',
        'measuring_tools', 'drawing_reading', 'sheet_thickness',
        'nesting_software', 'press_brake_setting', 'layout_calculation',
        'assembly_finishing', 'iti_workshop_machines',
      ],
      'qp_press_operation': <String>[
        'press_machine', 'material_worked', 'press_safety', 'press_tonnage',
        'drawing_reading', 'press_setting', 'press_stroke_rate',
        'press_die_type', 'press_defect', 'press_maintenance',
        'iti_workshop_machines',
      ],
      'qp_fitter': <String>[
        'fitter_work_type', 'fitter_equipment', 'fitting_work',
        'measuring_tools', 'drawing_reading', 'fitting_alignment',
        'fitter_hydraulic_work', 'fitter_overhaul', 'fitter_erection',
        'fitter_fault_finding', 'iti_workshop_machines',
      ],
      'qp_maintenance_tech': <String>[
        'maintenance_discipline', 'maintenance_equipment', 'maintenance_type',
        'measuring_tools', 'drawing_reading', 'maintenance_response',
        'maintenance_documentation', 'maintenance_fluid_power',
        'maintenance_fault_finding', 'maintenance_overhaul',
        'iti_workshop_machines',
      ],
      'qp_industrial_electrician': <String>[
        'electrical_work_type', 'electrical_equipment', 'panel_motor_work',
        'measuring_tools', 'drawing_reading', 'electrical_voltage',
        'electrical_licence', 'control_circuit', 'motor_fault',
        'electrical_safety', 'iti_workshop_machines',
      ],
      'qp_assembly_line': <String>[
        'assembly_stage', 'assembly_line_product', 'assembly_tool',
        'assembly_practice', 'drawing_reading', 'assembly_takt_time',
        'assembly_joining', 'assembly_station_count',
        'assembly_responsibility', 'assembly_defect', 'iti_workshop_machines',
      ],
      'qp_quality_inspection': <String>[
        'measuring_tools', 'material_worked', 'inspection_stage',
        'drawing_reading', 'inspection_least_count', 'inspection_standard',
        'inspection_documentation', 'inspection_cmm_work',
        'inspection_rejection_work', 'inspection_audit_work',
        'iti_workshop_machines',
      ],
    };

    final Map<String, ShippedPack> formPacks = readFormPacks();
    final TradeFormStepFilter filter =
        tradeFormSectionFilterFor(kResumeMenuTechnicalSkillsKey)!;

    test('pins every known form trade, and only those', () {
      expect(expected.keys.toSet(), kKnownFormPackIds);
    });

    for (final MapEntry<String, List<String>> trade in expected.entries) {
      test('${trade.key} asks exactly its capability questions', () {
        final ShippedPack pack = formPacks[trade.key]!;
        expect(
          <String>[
            for (final String key in pack.questionKeys)
              if (filter(_step(key))) key,
          ],
          trade.value,
        );
      });
    }

    test('Batch 2: tenure and self-level questions are Experience, not skills',
        () {
      const List<String> experience = <String>[
        'sheet_metal_experience', 'sheet_metal_level',
        'press_experience', 'press_level',
        'fitting_experience', 'fitter_level',
        'maintenance_experience', 'maintenance_level',
        'electrical_experience', 'electrician_level',
        'assembly_experience', 'assembly_level',
        'inspection_experience', 'inspection_level',
      ];
      for (final String key in experience) {
        expect(knownFormTopicFor(key)?.$1, 'Experience', reason: key);
        expect(filter(_step(key)), isFalse, reason: key);
      }
    });
  });

  group('Availability, Terms & Salary keeps only the preferences marker', () {
    test('the preferences marker is asked', () {
      final TradeFormStepFilter filter =
          tradeFormSectionFilterFor(kResumeMenuAvailabilitySalaryKey)!;
      expect(filter(const TradeFormPreferencesStep()), isTrue);
    });

    test('capability questions and other markers are dropped', () {
      final TradeFormStepFilter filter =
          tradeFormSectionFilterFor(kResumeMenuAvailabilitySalaryKey)!;
      expect(filter(_step('turning_machine')), isFalse);
      expect(filter(_step('turning_operation')), isFalse);
      expect(filter(_step('turning_experience')), isFalse);
      expect(filter(const TradeFormEmploymentStep()), isFalse);
      expect(filter(const TradeFormQualificationsStep()), isFalse);
    });
  });

  group('Work History keeps only the employment marker', () {
    test('the employment marker is asked', () {
      final TradeFormStepFilter filter =
          tradeFormSectionFilterFor(kResumeMenuWorkHistoryKey)!;
      expect(filter(const TradeFormEmploymentStep()), isTrue);
    });

    test('capability questions and other markers are dropped', () {
      final TradeFormStepFilter filter =
          tradeFormSectionFilterFor(kResumeMenuWorkHistoryKey)!;
      expect(filter(_step('turning_machine')), isFalse);
      expect(filter(_step('turning_operation')), isFalse);
      expect(filter(_step('turning_experience')), isFalse);
      expect(filter(const TradeFormPreferencesStep()), isFalse);
      expect(filter(const TradeFormQualificationsStep()), isFalse);
    });
  });

  group('Education & Certifications keeps only the qualifications marker', () {
    test('the qualifications marker is asked', () {
      final TradeFormStepFilter filter =
          tradeFormSectionFilterFor(kResumeMenuEducationKey)!;
      expect(filter(const TradeFormQualificationsStep()), isTrue);
    });

    test('capability questions and other markers are dropped', () {
      final TradeFormStepFilter filter =
          tradeFormSectionFilterFor(kResumeMenuEducationKey)!;
      expect(filter(_step('turning_machine')), isFalse);
      expect(filter(_step('turning_operation')), isFalse);
      expect(filter(_step('turning_experience')), isFalse);
      expect(filter(const TradeFormPreferencesStep()), isFalse);
      expect(filter(const TradeFormEmploymentStep()), isFalse);
    });

    // MARKER-ONLY BY DESIGN: the Training-category questions also feed this
    // résumé section, but combining them with the marker strands the done
    // marker (cubit forward moves skip saved markers). They are deliberately
    // dropped from this single-step walk; see `_isEducationStep`'s doc.
    test('training questions stay out of the marker-only walk', () {
      final TradeFormStepFilter filter =
          tradeFormSectionFilterFor(kResumeMenuEducationKey)!;
      expect(filter(_step('iti_project_work')), isFalse);
      expect(filter(_step('trade_test_status')), isFalse);
    });
  });
}
