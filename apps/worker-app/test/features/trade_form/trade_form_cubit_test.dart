import 'package:badabhai_worker_app/core/error/failure.dart';
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

  TradeFormCubit build() => TradeFormCubit(repo);

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
    /// Walks a fresh [cubit] from load() through both questions and both
    /// existing markers, landing on the qualifications marker — the exact
    /// path a worker takes, never reaching into Cubit's protected `emit`.
    Future<TradeFormCubit> walkToQualifications() async {
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
      final TradeFormCubit cubit = build();
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
}
