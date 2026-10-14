import 'package:badabhai_worker_app/features/trade_form/data/trade_form_marker_store.dart';
import 'package:badabhai_worker_app/features/trade_form/domain/form_fact_registry.dart';
import 'package:badabhai_worker_app/features/trade_form/domain/trade_form_models.dart';
import 'package:badabhai_worker_app/features/trade_form/domain/trade_form_repository.dart';
import 'package:badabhai_worker_app/features/trade_form/presentation/cubit/trade_form_cubit.dart';
import 'package:badabhai_worker_app/features/voice_form/domain/voice_form_models.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

class _MockRepo extends Mock implements TradeFormRepository {}

const VoiceQuestion _q1 = VoiceQuestion(
  id: 'turning_machine',
  prompt: 'Aap kaunsi turning machine chalate hain?',
  kind: VoiceQuestionKind.multiSelect,
  options: <VoiceChoice>[VoiceChoice(key: 'cnc_lathe', label: 'CNC lathe')],
);

const VoiceQuestion _q2 = VoiceQuestion(
  id: 'material_worked',
  prompt: 'Aap kaunsi dhaatu par kaam karte hain?',
  kind: VoiceQuestionKind.multiSelect,
  options: <VoiceChoice>[VoiceChoice(key: 'mild_steel', label: 'Mild steel')],
);

/// The worker shape #2200 was reported on: every question answered and every
/// marker page already saved, so a RESUMED walk has nothing left but its last
/// step — one screen with "Submit karein".
const TradeForm _completedForm = TradeForm(
  kind: 'cnc_turner',
  packId: 'qp_cnc_turning',
  packVersion: 1,
  sections: <TradeFormSection>[
    TradeFormSection(
      id: 'capability',
      title: 'Machines',
      screens: <TradeFormStep>[
        TradeFormQuestionStep(
          question: _q1,
          searchable: false,
          answer: TradeFormSavedAnswer(
            status: TradeFormAnswerStatus.answered,
            optionKeys: <String>['cnc_lathe'],
          ),
        ),
        TradeFormQuestionStep(
          question: _q2,
          searchable: false,
          answer: TradeFormSavedAnswer(
            status: TradeFormAnswerStatus.answered,
            optionKeys: <String>['mild_steel'],
          ),
        ),
      ],
    ),
    TradeFormSection(
      id: 'work_history',
      title: 'Work history',
      screens: <TradeFormStep>[TradeFormEmploymentStep()],
    ),
    TradeFormSection(
      id: 'qualifications',
      title: 'Certificates and education',
      screens: <TradeFormStep>[TradeFormQualificationsStep()],
    ),
  ],
);

/// ── #2200: "Resume poora karein" asked ONE question, then Submit ──────────
///
/// The draft card's continuation must walk EVERY step — each question, then
/// work history, then certificates/education — and offer "Submit karein" on
/// the last step only.
void main() {
  late _MockRepo repo;
  late TradeFormMarkerStore markers;

  setUpAll(() {
    registerFallbackValue(const TradeFormAnswer.declined());
    registerFallbackValue(const TradeFormQualifications());
  });

  setUp(() async {
    repo = _MockRepo();
    markers = InMemoryTradeFormMarkerStore();
    await markers.markCompleted(TradeFormMarkerType.employment);
    await markers.markCompleted(TradeFormMarkerType.qualifications);
    when(() => repo.loadForm()).thenAnswer((_) async => _completedForm);
    when(() => repo.loadSavedPreferences()).thenAnswer((_) async => null);
    when(() => repo.loadSavedEmployment())
        .thenAnswer((_) async => const TradeFormStoredEmployment());
    when(() => repo.loadSavedQualifications()).thenAnswer((_) async => null);
    when(() => repo.submitAnswer(
          questionKey: any(named: 'questionKey'),
          answer: any(named: 'answer'),
        )).thenAnswer((_) async => const TradeFormAnswerResult(
          questionKey: 'x',
          status: TradeFormAnswerStatus.answered,
          answered: 2,
          total: 2,
        ));
    when(() => repo.saveQualifications(any())).thenAnswer((_) async {});
  });

  TradeFormCubit build() => TradeFormCubit(repo, markerStore: markers);

  test('BASELINE — a resumed walk is one screen with Submit (the report)',
      () async {
    final TradeFormCubit cubit = build();
    await cubit.load();
    expect(cubit.state.isLastStep, isTrue,
        reason: 'resumed onto the last step: "Submit karein" straight away');
  });

  test(
      'fromStart walks EVERY step in order, and Submit appears on the last '
      'step only', () async {
    final TradeFormCubit cubit = build();
    await cubit.load(fromStart: true);

    final List<String> visited = <String>[];
    final List<bool> submitShown = <bool>[];
    void record() {
      final TradeFormStep step = cubit.state.currentStep!;
      visited.add(switch (step) {
        TradeFormQuestionStep(:final VoiceQuestion question) => question.id,
        TradeFormEmploymentStep() => 'employment',
        TradeFormQualificationsStep() => 'qualifications',
        _ => step.runtimeType.toString(),
      });
      submitShown.add(cubit.state.isLastStep);
    }

    record();
    await cubit.answerQuestion(
      cubit.state.currentStep! as TradeFormQuestionStep,
      const TradeFormAnswer.chips(<String>['cnc_lathe']),
    );
    record();
    await cubit.answerQuestion(
      cubit.state.currentStep! as TradeFormQuestionStep,
      const TradeFormAnswer.chips(<String>['mild_steel']),
    );
    record();
    cubit.skipEmploymentAndAdvance();
    record();

    expect(visited, <String>[
      'turning_machine',
      'material_worked',
      'employment',
      'qualifications',
    ], reason: 'nothing skipped — work history and certificates included');
    expect(submitShown, <bool>[false, false, false, true],
        reason: '"Submit karein" only on the final step');

    await cubit.saveQualificationsAndAdvance(const TradeFormQualifications());
    expect(cubit.state.status, TradeFormStatus.done,
        reason: 'done only after the last step');
  });
}
