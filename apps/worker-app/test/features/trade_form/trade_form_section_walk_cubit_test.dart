import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/features/chat/domain/chat_resume_menu.dart';
import 'package:badabhai_worker_app/features/trade_form/domain/trade_form_models.dart';
import 'package:badabhai_worker_app/features/trade_form/domain/trade_form_repository.dart';
import 'package:badabhai_worker_app/features/trade_form/presentation/cubit/trade_form_cubit.dart';
import 'package:badabhai_worker_app/features/voice_form/domain/voice_form_models.dart';

/// ── THE SECTION-FILTERED CUBIT WALK (the four résumé-section walks) ──
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
        const TradeFormSection(
          id: 'education',
          title: 'Education',
          screens: <TradeFormStep>[TradeFormQualificationsStep()],
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

    expect(cubit.state.flatSteps, hasLength(8));
    expect(cubit.state.currentIndex, 0);
  });

  test('an unknown section key degrades to the whole form, never an empty walk',
      () async {
    final TradeFormCubit cubit = TradeFormCubit(repo);
    await cubit.load(sectionKey: 'section_something_future');

    expect(cubit.state.status, TradeFormStatus.ready);
    expect(cubit.state.flatSteps, hasLength(8));
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
    // Opens at the SECTION's first step (index 0 of the filtered walk).
    expect(cubit.state.currentIndex, 0);
    expect(
      (cubit.state.currentStep as TradeFormQuestionStep).question.id,
      'turning_machine',
    );
  });

  // ── P6 (2026-10-16): a section walk opens at its FIRST step ─────────────
  //
  // Before, the walk RESUMED: a worker whose Technical Skills were all
  // answered (every finished worker who taps the chip) landed on the
  // section's LAST question with "Submit karein", and a partly answered
  // section opened on the gap, past the answered questions in front of it.
  group('a Technical Skills walk opens at the section\'s first question', () {
    TradeForm technicalSkills({required bool firstAnswered,
        required bool secondAnswered}) =>
        TradeForm(
          kind: 'cnc_turner',
          packId: 'qp_cnc_turning',
          packVersion: 1,
          sections: <TradeFormSection>[
            TradeFormSection(
              id: 's1',
              title: 'S1',
              screens: <TradeFormStep>[
                _step('turning_experience', answered: true),
                _step('turning_machine', answered: firstAnswered),
                _step('material_worked', answered: secondAnswered),
              ],
            ),
            const TradeFormSection(
              id: 'terms',
              title: 'Terms',
              screens: <TradeFormStep>[TradeFormPreferencesStep()],
            ),
          ],
        );

    test('every question answered: step 1 of 2, not the last with Submit',
        () async {
      when(() => repo.loadForm()).thenAnswer((_) async =>
          technicalSkills(firstAnswered: true, secondAnswered: true));
      final TradeFormCubit cubit = TradeFormCubit(repo);
      await cubit.load(sectionKey: kResumeMenuTechnicalSkillsKey);

      expect(cubit.state.currentIndex, 0);
      expect((cubit.state.currentStep as TradeFormQuestionStep).question.id,
          'turning_machine');
      expect(cubit.state.isLastStep, isFalse,
          reason: '"Submit karein" only after the worker walks the section');
    });

    test('a gap later in the section still opens at step 1', () async {
      when(() => repo.loadForm()).thenAnswer((_) async =>
          technicalSkills(firstAnswered: true, secondAnswered: false));
      final TradeFormCubit cubit = TradeFormCubit(repo);
      await cubit.load(sectionKey: kResumeMenuTechnicalSkillsKey);

      expect(cubit.state.currentIndex, 0);
      expect((cubit.state.currentStep as TradeFormQuestionStep).question.id,
          'turning_machine');
    });

    test('the FULL walk still resumes — only section walks changed', () async {
      when(() => repo.loadForm()).thenAnswer((_) async =>
          technicalSkills(firstAnswered: true, secondAnswered: false));
      final TradeFormCubit cubit = TradeFormCubit(repo);
      await cubit.load();

      expect((cubit.state.currentStep as TradeFormQuestionStep).question.id,
          'material_worked',
          reason: 'the full walk resumes at the first unanswered question');
    });
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

  test('the Availability walk keeps only the preferences marker', () async {
    final TradeFormCubit cubit = TradeFormCubit(repo);
    await cubit.load(sectionKey: kResumeMenuAvailabilitySalaryKey);

    expect(cubit.state.status, TradeFormStatus.ready,
        reason: 'load error: ${cubit.state.loadError}');
    expect(cubit.state.flatSteps, hasLength(1));
    expect(cubit.state.currentStep, isA<TradeFormPreferencesStep>());
    // Prefill ran for the marker this walk carries, so the page opens with
    // the stored record instead of blank (a blank whole-record PUT would
    // destroy data on save).
    verify(() => repo.loadSavedPreferences()).called(1);
  });

  test('the Work History walk keeps only the employment marker', () async {
    final TradeFormCubit cubit = TradeFormCubit(repo);
    await cubit.load(sectionKey: kResumeMenuWorkHistoryKey);

    expect(cubit.state.status, TradeFormStatus.ready,
        reason: 'load error: ${cubit.state.loadError}');
    expect(cubit.state.flatSteps, hasLength(1));
    expect(cubit.state.currentStep, isA<TradeFormEmploymentStep>());
    // Prefill ran for the marker this walk carries (#1710), so the page opens
    // with the stored history instead of blank (a blank whole-history PUT
    // would delete it on save).
    verify(() => repo.loadSavedEmployment()).called(1);

    // A bare retry KEEPS the section walk instead of widening it to the form.
    await cubit.load();
    expect(cubit.state.flatSteps, hasLength(1));
    expect(cubit.state.currentStep, isA<TradeFormEmploymentStep>());
  });

  test(
      'the Education & Certifications walk keeps only the qualifications '
      'marker', () async {
    final TradeFormCubit cubit = TradeFormCubit(repo);
    await cubit.load(sectionKey: kResumeMenuEducationKey);

    expect(cubit.state.status, TradeFormStatus.ready,
        reason: 'load error: ${cubit.state.loadError}');
    expect(cubit.state.flatSteps, hasLength(1));
    expect(cubit.state.currentStep, isA<TradeFormQualificationsStep>());
    // Prefill ran for the marker this walk carries (#1710), so the page opens
    // with the stored qualifications instead of blank (a blank whole-record
    // PUT would delete them on save).
    verify(() => repo.loadSavedQualifications()).called(1);

    // A bare retry KEEPS the section walk instead of widening it to the form.
    await cubit.load();
    expect(cubit.state.flatSteps, hasLength(1));
    expect(cubit.state.currentStep, isA<TradeFormQualificationsStep>());
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
