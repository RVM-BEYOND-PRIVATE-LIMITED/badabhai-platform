import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/session/known_worker_facts_store.dart';
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

/// [q1] pre-answered, [q2] unanswered, both markers, in server order — the
/// exact shape "resumability" is about.
TradeForm _form({bool q1Answered = true}) => TradeForm(
      kind: 'cnc_turner',
      packId: 'qp_cnc_turning',
      packVersion: 1,
      sections: <TradeFormSection>[
        TradeFormSection(
          id: 'capability',
          title: 'Machines, controllers & capability',
          screens: <TradeFormStep>[
            TradeFormQuestionStep(
              question: _q1,
              searchable: false,
              answer: q1Answered
                  ? const TradeFormSavedAnswer(
                      status: TradeFormAnswerStatus.answered,
                      optionKeys: <String>['cnc_lathe'],
                    )
                  : null,
            ),
            const TradeFormQuestionStep(question: _q2, searchable: false),
          ],
        ),
        const TradeFormSection(
          id: 'terms',
          title: 'Availability & terms',
          screens: <TradeFormStep>[TradeFormPreferencesStep()],
        ),
        const TradeFormSection(
          id: 'work_history',
          title: 'Work history',
          screens: <TradeFormStep>[TradeFormEmploymentStep()],
        ),
      ],
    );

/// [_form] extended with a THIRD marker (`qualifications`) as the walk's
/// actual last step — the #1384 qualifications-marker tests below need a
/// "Ho gaya" step to reach `done` from. Both questions start unanswered
/// (unlike [_form]'s own default) so the walk helper can answer each in
/// turn without a stale `currentStep` cast.
TradeForm _formWithQualifications() {
  final TradeForm base = _form(q1Answered: false);
  return TradeForm(
    kind: base.kind,
    packId: base.packId,
    packVersion: base.packVersion,
    sections: <TradeFormSection>[
      ...base.sections,
      const TradeFormSection(
        id: 'qualifications',
        title: 'Qualification, documents & languages',
        screens: <TradeFormStep>[TradeFormQualificationsStep()],
      ),
    ],
  );
}

/// [_form] with BOTH questions answered — what `GET /profiling/form` returns
/// once the worker is past the questions, so only the markers decide where a
/// fresh cubit resumes. [packId] lets a test point at a different form.
TradeForm _formBothAnswered({String packId = 'qp_cnc_turning'}) {
  final TradeForm base = _form();
  return TradeForm(
    kind: base.kind,
    packId: packId,
    packVersion: base.packVersion,
    sections: <TradeFormSection>[
      TradeFormSection(
        id: base.sections[0].id,
        title: base.sections[0].title,
        screens: <TradeFormStep>[
          base.sections[0].screens[0],
          const TradeFormQuestionStep(
            question: _q2,
            searchable: false,
            answer: TradeFormSavedAnswer(
              status: TradeFormAnswerStatus.answered,
              optionKeys: <String>['mild_steel'],
            ),
          ),
        ],
      ),
      ...base.sections.skip(1),
    ],
  );
}

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
  });

  TradeFormCubit build({TradeFormMarkerStore? store}) =>
      TradeFormCubit(repo, markerStore: store);

  /// Walks a fresh [cubit] from load() through both questions and both
  /// existing markers, landing on the qualifications marker — the exact
  /// path a worker takes, never reaching into Cubit's protected `emit`.
  /// Hoisted out of `group('saveQualificationsAndAdvance (#1384)', …)` (its
  /// original home) to file/`main()` scope so the #1384-item-1 "banked
  /// saves" group below can reuse it too.
  Future<TradeFormCubit> walkToQualifications({
    TradeFormMarkerStore? store,
  }) async {
    when(() => repo.loadForm()).thenAnswer((_) async => _formWithQualifications());
    when(() => repo.submitAnswer(
          questionKey: any(named: 'questionKey'),
          answer: any(named: 'answer'),
        )).thenAnswer((_) async => const TradeFormAnswerResult(
          questionKey: 'x',
          status: TradeFormAnswerStatus.answered,
          answered: 2,
          total: 2,
        ));
    when(() => repo.savePreferences(any())).thenAnswer((_) async {});
    when(() => repo.saveEmployment(any())).thenAnswer((_) async {});
    final TradeFormCubit cubit = build(store: store);
    await cubit.load();
    await cubit.answerQuestion(
      cubit.state.currentStep as TradeFormQuestionStep,
      const TradeFormAnswer.chips(<String>['cnc_lathe']),
    );
    await cubit.answerQuestion(
      cubit.state.currentStep as TradeFormQuestionStep,
      const TradeFormAnswer.chips(<String>['mild_steel']),
    );
    await cubit.savePreferencesAndAdvance(const TradeFormPreferences());
    await cubit.saveEmploymentAndAdvance(<TradeFormEmploymentEntry>[]);
    expect(cubit.state.currentStep, isA<TradeFormQualificationsStep>());
    expect(cubit.state.isLastStep, isTrue);
    return cubit;
  }

  test('load() resumes at the first UNANSWERED question, not index 0',
      () async {
    when(() => repo.loadForm()).thenAnswer((_) async => _form());
    final TradeFormCubit cubit = build();

    await cubit.load();

    expect(cubit.state.status, TradeFormStatus.ready);
    expect(cubit.state.total, 2);
    expect(cubit.state.answered, 1); // q1 already answered on load
    expect(cubit.state.currentIndex, 1); // q1's index, skipped
    expect((cubit.state.currentStep as TradeFormQuestionStep).question.id,
        'material_worked');
  });

  test('load() with everything unanswered starts at index 0', () async {
    when(() => repo.loadForm()).thenAnswer((_) async => _form(q1Answered: false));
    final TradeFormCubit cubit = build();

    await cubit.load();

    expect(cubit.state.currentIndex, 0);
    expect(cubit.state.answered, 0);
  });

  test('a 404 (no form) is a distinct status, never a blank ready form',
      () async {
    when(() => repo.loadForm()).thenAnswer((_) async => null);
    final TradeFormCubit cubit = build();

    await cubit.load();

    expect(cubit.state.status, TradeFormStatus.noForm);
  });

  test('answerQuestion posts, banks the answer, and auto-advances', () async {
    when(() => repo.loadForm()).thenAnswer((_) async => _form());
    when(() => repo.submitAnswer(
          questionKey: any(named: 'questionKey'),
          answer: any(named: 'answer'),
        )).thenAnswer((_) async => const TradeFormAnswerResult(
          questionKey: 'material_worked',
          status: TradeFormAnswerStatus.answered,
          answered: 2,
          total: 2,
        ));
    final TradeFormCubit cubit = build();
    await cubit.load();
    final TradeFormQuestionStep step =
        cubit.state.currentStep as TradeFormQuestionStep;

    await cubit.answerQuestion(step, const TradeFormAnswer.chips(<String>['mild_steel']));

    expect(cubit.state.answered, 2);
    expect(cubit.state.total, 2);
    expect(cubit.state.submitError, isNull);
    // The flat step for material_worked is now banked as answered.
    final TradeFormQuestionStep banked = cubit.state.flatSteps
        .map((TradeFormFlatStep f) => f.step)
        .whereType<TradeFormQuestionStep>()
        .firstWhere((TradeFormQuestionStep q) => q.question.id == 'material_worked');
    expect(banked.isAnswered, isTrue);
  });

  test('declineQuestion submits {kind: declined}', () async {
    when(() => repo.loadForm()).thenAnswer((_) async => _form());
    when(() => repo.submitAnswer(
          questionKey: any(named: 'questionKey'),
          answer: any(named: 'answer'),
        )).thenAnswer((_) async => const TradeFormAnswerResult(
          questionKey: 'material_worked',
          status: TradeFormAnswerStatus.declined,
          answered: 2,
          total: 2,
        ));
    final TradeFormCubit cubit = build();
    await cubit.load();
    final TradeFormQuestionStep step =
        cubit.state.currentStep as TradeFormQuestionStep;

    await cubit.declineQuestion(step);

    final TradeFormAnswer sent = verify(() => repo.submitAnswer(
          questionKey: 'material_worked',
          answer: captureAny(named: 'answer'),
        )).captured.single as TradeFormAnswer;
    expect(sent.kind, TradeFormAnswerKind.declined);
  });

  test('a 400 (unknown option_key) keeps the worker on the same question',
      () async {
    when(() => repo.loadForm()).thenAnswer((_) async => _form());
    when(() => repo.submitAnswer(
          questionKey: any(named: 'questionKey'),
          answer: any(named: 'answer'),
        )).thenThrow(const InvalidRequestFailure('unknown option keys: bogus'));
    final TradeFormCubit cubit = build();
    await cubit.load();
    final int before = cubit.state.currentIndex;
    final TradeFormQuestionStep step =
        cubit.state.currentStep as TradeFormQuestionStep;

    await cubit.answerQuestion(step, const TradeFormAnswer.chips(<String>['bogus']));

    expect(cubit.state.currentIndex, before); // never advanced
    expect(cubit.state.submitError, 'unknown option keys: bogus');
    expect(cubit.state.status, TradeFormStatus.ready);
  });

  test('savePreferencesAndAdvance saves then moves to the next marker',
      () async {
    when(() => repo.loadForm()).thenAnswer((_) async => _form());
    when(() => repo.submitAnswer(
          questionKey: any(named: 'questionKey'),
          answer: any(named: 'answer'),
        )).thenAnswer((_) async => const TradeFormAnswerResult(
          questionKey: 'material_worked',
          status: TradeFormAnswerStatus.answered,
          answered: 2,
          total: 2,
        ));
    when(() => repo.savePreferences(any())).thenAnswer((_) async {});
    final TradeFormCubit cubit = build();
    await cubit.load();
    // Walk to the preferences marker the way the worker actually does — by
    // answering the one remaining question — rather than reaching into
    // Cubit's protected `emit`.
    await cubit.answerQuestion(
      cubit.state.currentStep as TradeFormQuestionStep,
      const TradeFormAnswer.chips(<String>['mild_steel']),
    );
    expect(cubit.state.currentStep, isA<TradeFormPreferencesStep>());

    await cubit.savePreferencesAndAdvance(const TradeFormPreferences());

    verify(() => repo.savePreferences(any())).called(1);
    expect(cubit.state.currentStep, isA<TradeFormEmploymentStep>());
  });

  test(
      'savePreferencesAndAdvance on the LAST step reaches done, never gets '
      'stuck at submitting (#1367)', () async {
    // A form whose last step IS the preferences marker — no employment
    // section after it.
    const TradeForm formPrefsLast = TradeForm(
      kind: 'cnc_turner',
      packId: 'qp_cnc_turning',
      packVersion: 1,
      sections: <TradeFormSection>[
        TradeFormSection(
          id: 'capability',
          title: 'Machines, controllers & capability',
          screens: <TradeFormStep>[
            TradeFormQuestionStep(question: _q1, searchable: false),
          ],
        ),
        TradeFormSection(
          id: 'terms',
          title: 'Availability & terms',
          screens: <TradeFormStep>[TradeFormPreferencesStep()],
        ),
      ],
    );
    when(() => repo.loadForm()).thenAnswer((_) async => formPrefsLast);
    when(() => repo.submitAnswer(
          questionKey: any(named: 'questionKey'),
          answer: any(named: 'answer'),
        )).thenAnswer((_) async => const TradeFormAnswerResult(
          questionKey: 'turning_machine',
          status: TradeFormAnswerStatus.answered,
          answered: 1,
          total: 1,
        ));
    when(() => repo.savePreferences(any())).thenAnswer((_) async {});
    final TradeFormCubit cubit = build();
    await cubit.load();
    await cubit.answerQuestion(
      cubit.state.currentStep as TradeFormQuestionStep,
      const TradeFormAnswer.chips(<String>['cnc_lathe']),
    );
    expect(cubit.state.currentStep, isA<TradeFormPreferencesStep>());
    expect(cubit.state.isLastStep, isTrue);

    await cubit.savePreferencesAndAdvance(const TradeFormPreferences());

    verify(() => repo.savePreferences(any())).called(1);
    expect(cubit.state.status, TradeFormStatus.done);
    expect(cubit.state.status, isNot(TradeFormStatus.submitting));
  });

  test(
      'saveEmploymentAndAdvance on the LAST step reaches done, never gets '
      'stuck at submitting (#1367)', () async {
    when(() => repo.loadForm()).thenAnswer((_) async => _form());
    when(() => repo.submitAnswer(
          questionKey: any(named: 'questionKey'),
          answer: any(named: 'answer'),
        )).thenAnswer((_) async => const TradeFormAnswerResult(
          questionKey: 'material_worked',
          status: TradeFormAnswerStatus.answered,
          answered: 2,
          total: 2,
        ));
    when(() => repo.savePreferences(any())).thenAnswer((_) async {});
    when(() => repo.saveEmployment(any())).thenAnswer((_) async {});
    final TradeFormCubit cubit = build();
    await cubit.load();
    await cubit.answerQuestion(
      cubit.state.currentStep as TradeFormQuestionStep,
      const TradeFormAnswer.chips(<String>['mild_steel']),
    );
    await cubit.savePreferencesAndAdvance(const TradeFormPreferences());
    expect(cubit.state.currentStep, isA<TradeFormEmploymentStep>());
    expect(cubit.state.isLastStep, isTrue);

    await cubit.saveEmploymentAndAdvance(<TradeFormEmploymentEntry>[
      const TradeFormEmploymentEntry(employerName: 'Acme', roleLabel: 'Fitter'),
    ]);

    verify(() => repo.saveEmployment(any())).called(1);
    expect(cubit.state.status, TradeFormStatus.done);
    expect(cubit.state.status, isNot(TradeFormStatus.submitting));
  });

  group('schema_stale (#1382 — forward-compatible groundwork)', () {
    test(
        'schema_stale absent/false does NOT re-fetch — loadForm is called '
        'exactly once (the initial load)', () async {
      when(() => repo.loadForm()).thenAnswer((_) async => _form());
      when(() => repo.submitAnswer(
            questionKey: any(named: 'questionKey'),
            answer: any(named: 'answer'),
          )).thenAnswer((_) async => const TradeFormAnswerResult(
            questionKey: 'material_worked',
            status: TradeFormAnswerStatus.answered,
            answered: 2,
            total: 2,
          ));
      final TradeFormCubit cubit = build();
      await cubit.load();

      await cubit.answerQuestion(
        cubit.state.currentStep as TradeFormQuestionStep,
        const TradeFormAnswer.chips(<String>['mild_steel']),
      );

      verify(() => repo.loadForm()).called(1);
      expect(cubit.state.currentStep, isA<TradeFormPreferencesStep>());
    });

    test(
        'schema_stale: true re-fetches and lands on the correct NEXT step, '
        'never resetting to the first unanswered question overall', () async {
      // The initial form: q1 unanswered, q2 unanswered, then a THIRD
      // question a real ask_if-filtered pack would have removed once q1 is
      // answered — simulated by the re-fetched form below being SHORTER.
      const VoiceQuestion q3 = VoiceQuestion(
        id: 'iti_fresher_only',
        prompt: 'ITI fresher wala sawaal',
        kind: VoiceQuestionKind.boolean,
      );
      final TradeForm initial = TradeForm(
        kind: 'cnc_turner',
        packId: 'qp_cnc_turning',
        packVersion: 1,
        sections: <TradeFormSection>[
          TradeFormSection(
            id: 'capability',
            title: 'Machines, controllers & capability',
            screens: <TradeFormStep>[
              const TradeFormQuestionStep(question: _q1, searchable: false),
              const TradeFormQuestionStep(question: _q2, searchable: false),
              const TradeFormQuestionStep(question: q3, searchable: false),
            ],
          ),
        ],
      );
      // Re-fetched AFTER answering q1: q1 now answered, q3 (the fresher-only
      // question) is GATED OUT entirely by ask_if — a real server response,
      // not a client guess. The worker must land on q2, not q3, and not
      // back at q1.
      final TradeForm refetched = TradeForm(
        kind: 'cnc_turner',
        packId: 'qp_cnc_turning',
        packVersion: 1,
        sections: <TradeFormSection>[
          TradeFormSection(
            id: 'capability',
            title: 'Machines, controllers & capability',
            screens: <TradeFormStep>[
              const TradeFormQuestionStep(
                question: _q1,
                searchable: false,
                answer: TradeFormSavedAnswer(
                  status: TradeFormAnswerStatus.answered,
                  optionKeys: <String>['cnc_lathe'],
                ),
              ),
              const TradeFormQuestionStep(question: _q2, searchable: false),
            ],
          ),
        ],
      );
      when(() => repo.loadForm()).thenAnswer((_) async => initial);
      when(() => repo.submitAnswer(
            questionKey: any(named: 'questionKey'),
            answer: any(named: 'answer'),
          )).thenAnswer((_) async => const TradeFormAnswerResult(
            questionKey: 'turning_machine',
            status: TradeFormAnswerStatus.answered,
            answered: 1,
            total: 2,
            schemaStale: true,
          ));
      final TradeFormCubit cubit = build();
      await cubit.load();
      expect(cubit.state.currentIndex, 0); // starts on q1, nothing answered

      // The re-fetch happens on the NEXT loadForm() call — swap the stub so
      // the resync sees the post-answer schema.
      when(() => repo.loadForm()).thenAnswer((_) async => refetched);
      await cubit.answerQuestion(
        cubit.state.currentStep as TradeFormQuestionStep,
        const TradeFormAnswer.chips(<String>['cnc_lathe']),
      );

      verify(() => repo.loadForm()).called(2); // initial load + resync
      expect(cubit.state.status, TradeFormStatus.ready);
      expect((cubit.state.currentStep as TradeFormQuestionStep).question.id,
          'material_worked'); // q2 — never q1 (backward) or q3 (gone)
      expect(cubit.state.answered, 1); // server's own count, not recomputed
      expect(cubit.state.total, 2);
    });

    test(
        'schema_stale: true whose refetch fails falls back to the '
        'locally-banked answer rather than losing it', () async {
      when(() => repo.loadForm()).thenAnswer((_) async => _form());
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
      await cubit.load();

      when(() => repo.loadForm())
          .thenThrow(const NetworkFailure('offline'));
      await cubit.answerQuestion(
        cubit.state.currentStep as TradeFormQuestionStep,
        const TradeFormAnswer.chips(<String>['mild_steel']),
      );

      expect(cubit.state.status, TradeFormStatus.ready);
      expect(cubit.state.submitError, isNotNull);
      final TradeFormQuestionStep banked = cubit.state.flatSteps
          .map((TradeFormFlatStep f) => f.step)
          .whereType<TradeFormQuestionStep>()
          .firstWhere((TradeFormQuestionStep q) => q.question.id == 'material_worked');
      expect(banked.isAnswered, isTrue); // the submit that DID land is kept
    });
  });

  test('saveEmploymentAndAdvance blocks on a partially-typed employer',
      () async {
    when(() => repo.loadForm()).thenAnswer((_) async => _form());
    when(() => repo.submitAnswer(
          questionKey: any(named: 'questionKey'),
          answer: any(named: 'answer'),
        )).thenAnswer((_) async => const TradeFormAnswerResult(
          questionKey: 'material_worked',
          status: TradeFormAnswerStatus.answered,
          answered: 2,
          total: 2,
        ));
    when(() => repo.savePreferences(any())).thenAnswer((_) async {});
    final TradeFormCubit cubit = build();
    await cubit.load();
    await cubit.answerQuestion(
      cubit.state.currentStep as TradeFormQuestionStep,
      const TradeFormAnswer.chips(<String>['mild_steel']),
    );
    await cubit.savePreferencesAndAdvance(const TradeFormPreferences());
    expect(cubit.state.currentStep, isA<TradeFormEmploymentStep>());

    await cubit.saveEmploymentAndAdvance(<TradeFormEmploymentEntry>[
      const TradeFormEmploymentEntry(employerName: 'Acme', roleLabel: ''),
    ]);

    expect(cubit.state.submitError, kTradeFormIncompleteEmployerMessage);
    verifyNever(() => repo.saveEmployment(any()));
  });

  group('saveQualificationsAndAdvance (#1384)', () {
    test(
        'a fully-touched save PUTs then reaches done, never stuck at '
        'submitting (#1367)', () async {
      final TradeFormCubit cubit = await walkToQualifications();
      when(() => repo.saveQualifications(any())).thenAnswer((_) async {});

      await cubit.saveQualificationsAndAdvance(const TradeFormQualifications(
        certificates: <TradeFormCertificateEntry>[
          TradeFormCertificateEntry(name: 'Fanuc Oi-TF Programming'),
        ],
        certificatesTouched: true,
      ));

      verify(() => repo.saveQualifications(any())).called(1);
      expect(cubit.state.status, TradeFormStatus.done);
      expect(cubit.state.status, isNot(TradeFormStatus.submitting));
    });

    test(
        'neither section touched skips the PUT entirely and still advances '
        '— an empty body would be the server\'s one deliberate 400',
        () async {
      final TradeFormCubit cubit = await walkToQualifications();

      await cubit.saveQualificationsAndAdvance(const TradeFormQualifications());

      verifyNever(() => repo.saveQualifications(any()));
      expect(cubit.state.status, TradeFormStatus.done);
    });

    test('blank rows are dropped from both lists before the PUT', () async {
      final TradeFormCubit cubit = await walkToQualifications();
      when(() => repo.saveQualifications(any())).thenAnswer((_) async {});

      await cubit.saveQualificationsAndAdvance(const TradeFormQualifications(
        certificates: <TradeFormCertificateEntry>[
          TradeFormCertificateEntry(name: 'Fanuc Oi-TF Programming'),
          TradeFormCertificateEntry(name: ''), // added, never filled in
        ],
        certificatesTouched: true,
        educations: <TradeFormEducationEntry>[
          TradeFormEducationEntry(credential: 'iti'),
          TradeFormEducationEntry(), // added, never filled in
        ],
        educationsTouched: true,
      ));

      final TradeFormQualifications sent = verify(
              () => repo.saveQualifications(captureAny()))
          .captured
          .single as TradeFormQualifications;
      expect(sent.certificates, hasLength(1));
      expect(sent.certificates.single.name, 'Fanuc Oi-TF Programming');
      expect(sent.educations, hasLength(1));
      expect(sent.educations.single.credential, 'iti');
    });

    test(
        'a certificate missing its required name blocks the save with an '
        'honest message', () async {
      final TradeFormCubit cubit = await walkToQualifications();

      await cubit.saveQualificationsAndAdvance(const TradeFormQualifications(
        certificates: <TradeFormCertificateEntry>[
          TradeFormCertificateEntry(name: '', issuer: 'RVM CAD'),
        ],
        certificatesTouched: true,
      ));

      expect(cubit.state.submitError, kTradeFormIncompleteCertificateMessage);
      expect(cubit.state.status, isNot(TradeFormStatus.done));
      verifyNever(() => repo.saveQualifications(any()));
    });

    test('a 400 from the server keeps the worker on the same marker',
        () async {
      final TradeFormCubit cubit = await walkToQualifications();
      when(() => repo.saveQualifications(any()))
          .thenThrow(const InvalidRequestFailure(
              'remove contact details from the issuer'));

      await cubit.saveQualificationsAndAdvance(const TradeFormQualifications(
        certificates: <TradeFormCertificateEntry>[
          TradeFormCertificateEntry(name: 'ITI', issuer: '9876543210'),
        ],
        certificatesTouched: true,
      ));

      expect(cubit.state.submitError, 'remove contact details from the issuer');
      expect(cubit.state.status, TradeFormStatus.ready);
      expect(cubit.state.currentStep, isA<TradeFormQualificationsStep>());
    });
  });

  group('marker screens bank their last successful save (#1384 item 1)', () {
    test(
        'savePreferencesAndAdvance banks the saved value on '
        'TradeFormState.savedPreferences, untouched by a LATER employment '
        'save', () async {
      when(() => repo.loadForm()).thenAnswer((_) async => _form());
      when(() => repo.submitAnswer(
            questionKey: any(named: 'questionKey'),
            answer: any(named: 'answer'),
          )).thenAnswer((_) async => const TradeFormAnswerResult(
            questionKey: 'material_worked',
            status: TradeFormAnswerStatus.answered,
            answered: 2,
            total: 2,
          ));
      when(() => repo.savePreferences(any())).thenAnswer((_) async {});
      when(() => repo.saveEmployment(any())).thenAnswer((_) async {});
      final TradeFormCubit cubit = build();
      await cubit.load();
      await cubit.answerQuestion(
        cubit.state.currentStep as TradeFormQuestionStep,
        const TradeFormAnswer.chips(<String>['mild_steel']),
      );
      expect(cubit.state.savedPreferences, isNull);

      const TradeFormPreferences prefs = TradeFormPreferences(
        languages: <String>{'hindi'},
        preferredCities: <String>['Faridabad'],
      );
      await cubit.savePreferencesAndAdvance(prefs);

      expect(cubit.state.savedPreferences, prefs);
      expect(cubit.state.currentStep, isA<TradeFormEmploymentStep>());

      // Advancing past a DIFFERENT marker must never wipe what preferences
      // already banked — the sentinel-default plumbing in
      // `_advanceAfterMarkerSave` is exactly what this guards.
      await cubit.saveEmploymentAndAdvance(<TradeFormEmploymentEntry>[
        const TradeFormEmploymentEntry(employerName: 'Acme', roleLabel: 'Fitter'),
      ]);

      expect(cubit.state.savedPreferences, prefs);
      expect(
        cubit.state.savedEmployment,
        <TradeFormEmploymentEntry>[
          const TradeFormEmploymentEntry(employerName: 'Acme', roleLabel: 'Fitter'),
        ],
      );
    });

    test(
        'saveEmploymentAndAdvance banks the FILTERED (kept) list, not the '
        'raw list with blank rows still in it', () async {
      when(() => repo.loadForm()).thenAnswer((_) async => _form());
      when(() => repo.submitAnswer(
            questionKey: any(named: 'questionKey'),
            answer: any(named: 'answer'),
          )).thenAnswer((_) async => const TradeFormAnswerResult(
            questionKey: 'material_worked',
            status: TradeFormAnswerStatus.answered,
            answered: 2,
            total: 2,
          ));
      when(() => repo.savePreferences(any())).thenAnswer((_) async {});
      when(() => repo.saveEmployment(any())).thenAnswer((_) async {});
      final TradeFormCubit cubit = build();
      await cubit.load();
      await cubit.answerQuestion(
        cubit.state.currentStep as TradeFormQuestionStep,
        const TradeFormAnswer.chips(<String>['mild_steel']),
      );
      await cubit.savePreferencesAndAdvance(const TradeFormPreferences());

      await cubit.saveEmploymentAndAdvance(<TradeFormEmploymentEntry>[
        const TradeFormEmploymentEntry(employerName: 'Acme', roleLabel: 'Fitter'),
        const TradeFormEmploymentEntry(employerName: '', roleLabel: ''), // blank
      ]);

      expect(cubit.state.savedEmployment, hasLength(1));
      expect(cubit.state.savedEmployment!.single.employerName, 'Acme');
    });

    test(
        'saveQualificationsAndAdvance banks the touched-filtered value even '
        'when the PUT is skipped (nothing touched)', () async {
      final TradeFormCubit cubit = await walkToQualifications();

      await cubit.saveQualificationsAndAdvance(const TradeFormQualifications());

      verifyNever(() => repo.saveQualifications(any()));
      expect(cubit.state.savedQualifications, const TradeFormQualifications());
    });
  });

  group('a saved marker page is not asked again on re-entry', () {
    late InMemoryTradeFormMarkerStore store;

    setUp(() => store = InMemoryTradeFormMarkerStore());

    void stubAnswer({String questionKey = 'material_worked', bool stale = false}) {
      when(() => repo.submitAnswer(
            questionKey: any(named: 'questionKey'),
            answer: any(named: 'answer'),
          )).thenAnswer((_) async => TradeFormAnswerResult(
            questionKey: questionKey,
            status: TradeFormAnswerStatus.answered,
            answered: 2,
            total: 2,
            schemaStale: stale,
          ));
    }

    Future<void> recordPreferences() =>
        store.markCompleted(TradeFormMarkerType.preferences);

    test(
        'a fresh cubit after a completed preferences save resumes past it, '
        'and goBack still reaches it', () async {
      when(() => repo.loadForm()).thenAnswer((_) async => _form());
      stubAnswer();
      when(() => repo.savePreferences(any())).thenAnswer((_) async {});
      final TradeFormCubit first = build(store: store);
      await first.load();
      await first.answerQuestion(
        first.state.currentStep as TradeFormQuestionStep,
        const TradeFormAnswer.chips(<String>['mild_steel']),
      );
      await first.savePreferencesAndAdvance(const TradeFormPreferences());
      expect(first.state.currentStep, isA<TradeFormEmploymentStep>());
      await first.close();

      // Back from step 1 then the chat card, or a cold start: a NEW cubit.
      when(() => repo.loadForm()).thenAnswer((_) async => _formBothAnswered());
      final TradeFormCubit second = build(store: store);
      await second.load();

      expect(second.state.currentStep, isA<TradeFormEmploymentStep>());
      second.goBack();
      expect(second.state.currentStep, isA<TradeFormPreferencesStep>());

      // Control: with nothing recorded the same form opens on preferences.
      final TradeFormCubit control = build();
      await control.load();
      expect(control.state.currentStep, isA<TradeFormPreferencesStep>());
    });

    test('a FAILED preferences save is not recorded', () async {
      when(() => repo.loadForm()).thenAnswer((_) async => _form());
      stubAnswer();
      when(() => repo.savePreferences(any()))
          .thenThrow(const NetworkFailure('offline'));
      final TradeFormCubit first = build(store: store);
      await first.load();
      await first.answerQuestion(
        first.state.currentStep as TradeFormQuestionStep,
        const TradeFormAnswer.chips(<String>['mild_steel']),
      );
      await first.savePreferencesAndAdvance(const TradeFormPreferences());
      expect(first.state.currentStep, isA<TradeFormPreferencesStep>());

      expect(await store.completedMarkers(), isEmpty);
      when(() => repo.loadForm()).thenAnswer((_) async => _formBothAnswered());
      final TradeFormCubit second = build(store: store);
      await second.load();
      expect(second.state.currentStep, isA<TradeFormPreferencesStep>());
    });

    test(
        'a record belongs to the WORKER: a different trade form resumes past '
        'it too (the endpoints write the worker, not a form)', () async {
      await recordPreferences();

      when(() => repo.loadForm())
          .thenAnswer((_) async => _formBothAnswered(packId: 'qp_vmc_milling'));
      final TradeFormCubit other = build(store: store);
      await other.load();
      expect(other.state.currentStep, isA<TradeFormEmploymentStep>());

      when(() => repo.loadForm()).thenAnswer((_) async => _formBothAnswered());
      final TradeFormCubit same = build(store: store);
      await same.load();
      expect(same.state.currentStep, isA<TradeFormEmploymentStep>());
    });

    test('answering the question before a saved marker walks past it',
        () async {
      await recordPreferences();
      when(() => repo.loadForm()).thenAnswer((_) async => _form());
      stubAnswer();
      final TradeFormCubit cubit = build(store: store);
      await cubit.load();
      expect((cubit.state.currentStep as TradeFormQuestionStep).question.id,
          'material_worked');

      await cubit.answerQuestion(
        cubit.state.currentStep as TradeFormQuestionStep,
        const TradeFormAnswer.chips(<String>['mild_steel']),
      );

      expect(cubit.state.currentStep, isA<TradeFormEmploymentStep>());
    });

    test('when every remaining marker is saved, the last answer reaches done',
        () async {
      await recordPreferences();
      await store.markCompleted(TradeFormMarkerType.employment);
      when(() => repo.loadForm()).thenAnswer((_) async => _form());
      stubAnswer();
      final TradeFormCubit cubit = build(store: store);
      await cubit.load();

      await cubit.answerQuestion(
        cubit.state.currentStep as TradeFormQuestionStep,
        const TradeFormAnswer.chips(<String>['mild_steel']),
      );

      expect(cubit.state.status, TradeFormStatus.done);
    });

    // Review round 2: with nothing left to ask, a fresh cubit used to land on
    // the last step — the saved qualifications page, blank, asked again.
    test(
        'a fresh cubit on a fully completed form opens the last question, '
        'never a saved marker page', () async {
      await recordPreferences();
      await store.markCompleted(TradeFormMarkerType.employment);
      await store.markCompleted(TradeFormMarkerType.qualifications);
      final TradeForm base = _formBothAnswered();
      when(() => repo.loadForm()).thenAnswer((_) async => TradeForm(
            kind: base.kind,
            packId: base.packId,
            packVersion: base.packVersion,
            sections: <TradeFormSection>[
              ...base.sections,
              const TradeFormSection(
                id: 'qualifications',
                title: 'Qualification, documents & languages',
                screens: <TradeFormStep>[TradeFormQualificationsStep()],
              ),
            ],
          ));
      stubAnswer();
      final TradeFormCubit cubit = build(store: store);
      await cubit.load();

      expect(cubit.state.status, TradeFormStatus.ready);
      final TradeFormStep? step = cubit.state.currentStep;
      expect(step, isA<TradeFormQuestionStep>());
      expect((step! as TradeFormQuestionStep).question.id, 'material_worked');

      await cubit.answerQuestion(
        step as TradeFormQuestionStep,
        const TradeFormAnswer.chips(<String>['mild_steel']),
      );
      expect(cubit.state.status, TradeFormStatus.done,
          reason: 'every marker after it is saved: nothing is re-asked');
    });

    test('the schema_stale resync skips a saved marker too', () async {
      await recordPreferences();
      when(() => repo.loadForm()).thenAnswer((_) async => _form(q1Answered: false));
      stubAnswer(questionKey: 'turning_machine', stale: true);
      final TradeFormCubit cubit = build(store: store);
      await cubit.load();
      expect(cubit.state.currentIndex, 0);

      when(() => repo.loadForm()).thenAnswer((_) async => _formBothAnswered());
      await cubit.answerQuestion(
        cubit.state.currentStep as TradeFormQuestionStep,
        const TradeFormAnswer.chips(<String>['cnc_lathe']),
      );

      verify(() => repo.loadForm()).called(2);
      expect(cubit.state.currentStep, isA<TradeFormEmploymentStep>());
    });

    test('submitting the qualifications page with nothing to change is '
        'recorded as saved', () async {
      final TradeFormCubit cubit = await walkToQualifications(store: store);

      await cubit.saveQualificationsAndAdvance(const TradeFormQualifications());

      verifyNever(() => repo.saveQualifications(any()));
      expect(cubit.state.status, TradeFormStatus.done);
      expect(
        await store.completedMarkers(),
        <TradeFormMarkerType>{
          TradeFormMarkerType.preferences,
          TradeFormMarkerType.employment,
          TradeFormMarkerType.qualifications,
        },
      );
    });

    // Review round 1: a fresh cubit reaches a saved marker with goBack, and
    // the page opens blank (no read route). Passing through must not erase.
    test(
        'goBack onto a saved preferences page on a fresh cubit, then Aage, '
        'sends no list or yes/no key', () async {
      await recordPreferences();
      when(() => repo.loadForm()).thenAnswer((_) async => _formBothAnswered());
      when(() => repo.savePreferences(any())).thenAnswer((_) async {});
      final TradeFormCubit cubit = build(store: store);
      await cubit.load();
      expect(cubit.state.currentStep, isA<TradeFormEmploymentStep>());

      cubit.goBack();
      expect(cubit.state.currentStep, isA<TradeFormPreferencesStep>());
      expect(cubit.state.savedPreferences, isNull);
      // What the page sends when the worker touches nothing: its blank default.
      await cubit.savePreferencesAndAdvance(const TradeFormPreferences());

      final TradeFormPreferences sent =
          verify(() => repo.savePreferences(captureAny())).captured.single
              as TradeFormPreferences;
      expect(sent.toJson(), isEmpty,
          reason: 'an empty list would clear the stored languages and cities');
    });

    test(
        'an untouched employment page skips the whole-history replace and '
        'still counts as saved', () async {
      when(() => repo.loadForm()).thenAnswer((_) async => _formBothAnswered());
      when(() => repo.savePreferences(any())).thenAnswer((_) async {});
      final TradeFormCubit cubit = build(store: store);
      await cubit.load();
      await cubit.savePreferencesAndAdvance(const TradeFormPreferences());
      expect(cubit.state.currentStep, isA<TradeFormEmploymentStep>());

      cubit.skipEmploymentAndAdvance();

      verifyNever(() => repo.saveEmployment(any()));
      expect(cubit.state.status, TradeFormStatus.done);
      expect(await store.completedMarkers(),
          contains(TradeFormMarkerType.employment));
    });

    test(
        'isLastStep and the step counter leave out saved markers ahead of '
        'the current step', () async {
      await recordPreferences();
      await store.markCompleted(TradeFormMarkerType.employment);
      when(() => repo.loadForm()).thenAnswer((_) async => _form());
      final TradeFormCubit cubit = build(store: store);
      await cubit.load();

      expect((cubit.state.currentStep as TradeFormQuestionStep).question.id,
          'material_worked');
      expect(cubit.state.flatSteps, hasLength(4));
      expect(cubit.state.isLastStep, isTrue,
          reason: 'both markers after it are saved, so this answer finishes');
      expect(cubit.state.visibleStepCount, 2);
      expect(cubit.state.visiblePosition, 2);

      // Control: with nothing saved the same step is 2 of 4, not last.
      final TradeFormCubit control = build();
      await control.load();
      expect(control.state.isLastStep, isFalse);
      expect(control.state.visibleStepCount, 4);
      expect(control.state.visiblePosition, 2);
    });

    test('facts already given reach the state for the preferences page',
        () async {
      when(() => repo.loadForm()).thenAnswer((_) async => _form());
      final TradeFormCubit cubit = TradeFormCubit(
        repo,
        knownFacts: InMemoryKnownWorkerFactsStore(
            <WorkerFact>[WorkerFact.shift, WorkerFact.preferredCities]),
      );
      await cubit.load();

      expect(cubit.state.knownFacts,
          <WorkerFact>{WorkerFact.shift, WorkerFact.preferredCities});
    });
  });
}
