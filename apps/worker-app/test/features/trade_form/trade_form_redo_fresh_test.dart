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
  id: 'machine_features',
  prompt: 'Aapki machine mein kaunsa feature hai?',
  kind: VoiceQuestionKind.multiSelect,
  options: <VoiceChoice>[VoiceChoice(key: 'live_tooling', label: 'Live tooling')],
);

const TradeFormSavedAnswer _saved = TradeFormSavedAnswer(
  status: TradeFormAnswerStatus.answered,
  optionKeys: <String>['cnc_lathe'],
);

/// EXACTLY the server's answer for a worker re-making a résumé they already
/// built: every question answered from last time, every marker done.
TradeForm _everythingAnswered() => const TradeForm(
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
              answer: _saved,
            ),
            TradeFormQuestionStep(
              question: _q2,
              searchable: false,
              answer: TradeFormSavedAnswer(
                status: TradeFormAnswerStatus.answered,
                optionKeys: <String>['live_tooling'],
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
          title: 'Qualifications',
          screens: <TradeFormStep>[TradeFormQualificationsStep()],
        ),
      ],
    );

/// ── "Chat se resume banayein" → the form opened finished ─────────────────
///
/// The owner's report: the re-do opened on "Aapki machine mein kaunsa feature
/// hai?" with its old answer ticked, the bar at 100% and "Submit karein" under
/// it. Every question was answered from the résumé being replaced, so the walk
/// resumed onto the LAST question.
void main() {
  late _MockRepo repo;
  late TradeFormMarkerStore markers;

  setUpAll(() {
    registerFallbackValue(const TradeFormAnswer.declined());
  });

  setUp(() async {
    repo = _MockRepo();
    markers = InMemoryTradeFormMarkerStore();
    await markers.markCompleted(TradeFormMarkerType.employment);
    await markers.markCompleted(TradeFormMarkerType.qualifications);
    when(() => repo.loadForm()).thenAnswer((_) async => _everythingAnswered());
    when(() => repo.loadSavedPreferences()).thenAnswer((_) async => null);
    when(() => repo.loadSavedEmployment())
        .thenAnswer((_) async => const TradeFormStoredEmployment());
    when(() => repo.loadSavedQualifications()).thenAnswer((_) async => null);
  });

  TradeFormCubit build() => TradeFormCubit(repo, markerStore: markers);

  test('BASELINE — an ordinary load reproduces the report', () async {
    final TradeFormCubit cubit = build();
    await cubit.load();

    // The last question, its old answer on it, everything counted answered.
    expect((cubit.state.currentStep as TradeFormQuestionStep).question.id,
        'machine_features');
    expect((cubit.state.currentStep as TradeFormQuestionStep).isAnswered, isTrue);
    expect(cubit.state.answered, cubit.state.total);
  });

  group('a RE-DO (fresh)', () {
    test('opens on the FIRST question', () async {
      final TradeFormCubit cubit = build();
      await cubit.load(fresh: true);

      expect(cubit.state.status, TradeFormStatus.ready);
      expect(cubit.state.currentIndex, 0);
      expect((cubit.state.currentStep as TradeFormQuestionStep).question.id,
          'turning_machine');
      expect(cubit.state.isLastStep, isFalse,
          reason: '"Submit karein" belongs to the last step only');
    });

    test('nothing is pre-selected on any question', () async {
      final TradeFormCubit cubit = build();
      await cubit.load(fresh: true);

      for (final TradeFormFlatStep f in cubit.state.flatSteps) {
        if (f.step is TradeFormQuestionStep) {
          final TradeFormQuestionStep q = f.step as TradeFormQuestionStep;
          expect(q.answer, isNull, reason: '${q.question.id} must be blank');
          expect(q.suggestion, isNull);
        }
      }
    });

    test('progress starts at ZERO, not 100%', () async {
      final TradeFormCubit cubit = build();
      await cubit.load(fresh: true);
      expect(cubit.state.answered, 0);
    });

    test('marker pages are walked and open blank', () async {
      final TradeFormCubit cubit = build();
      await cubit.load(fresh: true);

      expect(
        cubit.state.flatSteps.map((TradeFormFlatStep f) => f.step.runtimeType),
        contains(TradeFormEmploymentStep),
      );
      verifyNever(() => repo.loadSavedEmployment());
      verifyNever(() => repo.loadSavedQualifications());
      verifyNever(() => repo.loadSavedPreferences());
    });

    test('progress counts THIS walk, whatever the server total says',
        () async {
      // The server still holds every old answer, so its own `answered` stays
      // at the full count — which is what put 100% on the bar.
      when(() => repo.submitAnswer(
            questionKey: any(named: 'questionKey'),
            answer: any(named: 'answer'),
          )).thenAnswer((_) async => const TradeFormAnswerResult(
            questionKey: 'turning_machine',
            status: TradeFormAnswerStatus.answered,
            answered: 2,
            total: 2,
          ));
      final TradeFormCubit cubit = build();
      await cubit.load(fresh: true);

      await cubit.answerQuestion(
        cubit.state.currentStep as TradeFormQuestionStep,
        const TradeFormAnswer.chips(<String>['cnc_lathe']),
      );

      expect(cubit.state.answered, 1);
      expect(cubit.state.currentIndex, 1, reason: 'walks on to question 2');
      expect((cubit.state.currentStep as TradeFormQuestionStep).isAnswered,
          isFalse,
          reason: 'question 2 is still blank — not its old answer');
    });

    test('a schema_stale re-fetch does not bring the old answers back',
        () async {
      when(() => repo.submitAnswer(
            questionKey: any(named: 'questionKey'),
            answer: any(named: 'answer'),
          )).thenAnswer((_) async => const TradeFormAnswerResult(
            questionKey: 'turning_machine',
            status: TradeFormAnswerStatus.answered,
            answered: 2,
            total: 2,
            schemaStale: true,
          ));
      final TradeFormCubit cubit = build();
      await cubit.load(fresh: true);

      await cubit.answerQuestion(
        cubit.state.currentStep as TradeFormQuestionStep,
        const TradeFormAnswer.chips(<String>['cnc_lathe']),
      );

      expect(cubit.state.answered, 1);
      final TradeFormQuestionStep q2 = cubit.state.flatSteps
          .map((TradeFormFlatStep f) => f.step)
          .whereType<TradeFormQuestionStep>()
          .firstWhere((TradeFormQuestionStep q) => q.question.id == 'machine_features');
      expect(q2.isAnswered, isFalse);
    });

    test('survives the error-state bare retry', () async {
      int calls = 0;
      when(() => repo.loadForm()).thenAnswer((_) async {
        calls++;
        if (calls == 1) throw Exception('offline');
        return _everythingAnswered();
      });
      final TradeFormCubit cubit = build();
      await cubit.load(fresh: true);
      expect(cubit.state.status, TradeFormStatus.loadError);

      await cubit.load(); // the error screen's retry, bare
      expect(cubit.state.currentIndex, 0);
      expect(cubit.state.answered, 0);
    });
  });
}
