import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/features/chat/domain/chat_resume_menu.dart';
import 'package:badabhai_worker_app/features/trade_form/domain/trade_form_models.dart';
import 'package:badabhai_worker_app/features/trade_form/domain/trade_form_repository.dart';
import 'package:badabhai_worker_app/features/trade_form/presentation/cubit/trade_form_cubit.dart';
import 'package:badabhai_worker_app/features/voice_form/domain/voice_form_models.dart';

/// ── THE SECTION-FILTERED CUBIT WALK (Technical Skills pilot) ────────────────
///
/// `load(sectionKey:)` narrows the walk to the section's steps; everything
/// else — per-step saves, auto-advance, `done` — is the unchanged full-walk
/// machinery operating on the narrowed list.
class _MockRepo extends Mock implements TradeFormRepository {}

VoiceQuestion _q(String id) => VoiceQuestion(
      id: id,
      prompt: 'Sawaal $id',
      kind: VoiceQuestionKind.multiSelect,
      options: const <VoiceChoice>[VoiceChoice(key: 'k', label: 'L')],
    );

TradeFormQuestionStep _step(String id, {bool answered = false}) =>
    TradeFormQuestionStep(
      question: _q(id),
      searchable: false,
      answer: answered
          ? const TradeFormSavedAnswer(
              status: TradeFormAnswerStatus.answered,
              optionKeys: <String>['k'],
            )
          : null,
    );

/// Capability, tenure, sector and training questions plus both markers, in
/// server order — the filter must keep only the capability ones.
TradeForm _form() => TradeForm(
      kind: 'cnc_turner',
      packId: 'qp_cnc_turning',
      packVersion: 1,
      sections: <TradeFormSection>[
        TradeFormSection(
          id: 's1',
          title: 'S1',
          screens: <TradeFormStep>[
            _step('turning_experience'),
            _step('turning_machine'),
            _step('material_worked', answered: true),
            _step('sector_worked'),
            _step('iti_project_work'),
          ],
        ),
        const TradeFormSection(
          id: 'terms',
          title: 'Terms',
          screens: <TradeFormStep>[TradeFormPreferencesStep()],
        ),
        const TradeFormSection(
          id: 'work_history',
          title: 'Work history',
          screens: <TradeFormStep>[TradeFormEmploymentStep()],
        ),
      ],
    );

void main() {
  late _MockRepo repo;

  setUpAll(() {
    registerFallbackValue(const TradeFormAnswer.declined());
    registerFallbackValue(const TradeFormPreferences());
    registerFallbackValue(<TradeFormEmploymentEntry>[]);
    registerFallbackValue(const TradeFormQualifications());
  });

  setUp(() {
    repo = _MockRepo();
      // #1710 — every load() now READS each marker page's stored record before
      // it draws. Nothing is stored in these tests, so the reads answer
      // "nothing saved", which is the state they were written against.
      when(() => repo.loadSavedPreferences()).thenAnswer((_) async => null);
      when(() => repo.loadSavedEmployment())
          .thenAnswer((_) async => const TradeFormStoredEmployment());
      when(() => repo.loadSavedQualifications()).thenAnswer((_) async => null);
    when(() => repo.loadForm()).thenAnswer((_) async => _form());
  });

  test('a null section key walks the whole form, exactly as today', () async {
    final TradeFormCubit cubit = TradeFormCubit(repo);
    await cubit.load();

    expect(cubit.state.flatSteps, hasLength(7));
    expect(cubit.state.currentIndex, 0);
  });

  test('an unknown section key degrades to the whole form, never an empty walk',
      () async {
    final TradeFormCubit cubit = TradeFormCubit(repo);
    await cubit.load(sectionKey: 'section_something_future');

    expect(cubit.state.status, TradeFormStatus.ready);
    expect(cubit.state.flatSteps, hasLength(7));
  });

  test('the Technical Skills walk keeps only capability questions, in order',
      () async {
    final TradeFormCubit cubit = TradeFormCubit(repo);
    await cubit.load(sectionKey: kResumeMenuTechnicalSkillsKey);

    final List<String> ids = <String>[
      for (final TradeFormFlatStep f in cubit.state.flatSteps)
        (f.step as TradeFormQuestionStep).question.id,
    ];
    expect(ids, <String>['turning_machine', 'material_worked']);
    // Resumes at the first UNANSWERED filtered step, not index 0 of the form.
    expect(cubit.state.currentIndex, 0);
    expect(
      (cubit.state.currentStep as TradeFormQuestionStep).question.id,
      'turning_machine',
    );
  });

  test('walking the filtered walk to its end emits done, markers never shown',
      () async {
    when(() => repo.submitAnswer(
          questionKey: any(named: 'questionKey'),
          answer: any(named: 'answer'),
        )).thenAnswer((_) async => const TradeFormAnswerResult(
          questionKey: 'turning_machine',
          status: TradeFormAnswerStatus.answered,
          answered: 2,
          total: 5,
        ));
    final TradeFormCubit cubit = TradeFormCubit(repo);
    await cubit.load(sectionKey: kResumeMenuTechnicalSkillsKey);

    await cubit.answerQuestion(
      cubit.state.currentStep as TradeFormQuestionStep,
      const TradeFormAnswer.chips(<String>['k']),
    );
    // material_worked was already answered server-side — the walk still shows
    // it (forward moves never skip answered questions), then finishes.
    expect(
      (cubit.state.currentStep as TradeFormQuestionStep).question.id,
      'material_worked',
    );

    await cubit.answerQuestion(
      cubit.state.currentStep as TradeFormQuestionStep,
      const TradeFormAnswer.chips(<String>['k']),
    );
    expect(cubit.state.status, TradeFormStatus.done);
    verifyNever(() => repo.savePreferences(any()));
    verifyNever(() => repo.saveEmployment(any(), expectedExistingCount: any(named: 'expectedExistingCount')));
  });

  test('a bare retry keeps the section walk instead of widening it', () async {
    final TradeFormCubit cubit = TradeFormCubit(repo);
    await cubit.load(sectionKey: kResumeMenuTechnicalSkillsKey);
    expect(cubit.state.status, TradeFormStatus.ready,
        reason: 'load error: ${cubit.state.loadError}');
    expect(cubit.state.flatSteps, hasLength(2));

    await cubit.load();
    expect(cubit.state.status, TradeFormStatus.ready,
        reason: 'reload error: ${cubit.state.loadError}');
    expect(cubit.state.flatSteps, hasLength(2));
  });
}
