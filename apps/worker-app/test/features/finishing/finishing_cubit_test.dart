import 'package:badabhai_worker_app/core/api/api_client.dart'
    show WorkPrefOptionsDto, SessionFillDto, SessionFillEntryDto;
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/session/known_worker_facts_store.dart';
import 'package:badabhai_worker_app/features/finishing/domain/finishing_models.dart';
import 'package:badabhai_worker_app/features/finishing/domain/finishing_repository.dart';
import 'package:badabhai_worker_app/features/finishing/presentation/cubit/finishing_cubit.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

class _MockRepo extends Mock implements FinishingRepository {}

const WorkPrefOptionsDto _options = WorkPrefOptionsDto(
  languages: <String, String>{'hindi': 'Hindi', 'english': 'English'},
  documentsReady: <String, String>{'aadhaar': 'Aadhaar', 'pan': 'PAN card'},
  jobType: <String, String>{'permanent': 'Permanent', 'contract': 'Contract'},
  shift: <String, String>{'day': 'Day', 'night': 'Night'},
);

void main() {
  late _MockRepo repo;

  setUpAll(() {
    registerFallbackValue(const WorkPreferences());
    registerFallbackValue(<EmploymentEntry>[]);
  });

  setUp(() {
    repo = _MockRepo();
    when(() => repo.loadOptions()).thenAnswer((_) async => _options);
    when(() => repo.loadSessionFill()).thenAnswer((_) async => null);
    when(() => repo.saveWorkPreferences(any())).thenAnswer((_) async {});
    when(() => repo.saveEmployment(any())).thenAnswer((_) async {});
  });

  FinishingCubit build() => FinishingCubit(repo);

  test('load() populates options and goes ready', () async {
    final FinishingCubit cubit = build();
    await cubit.load();
    expect(cubit.state.status, FinishingStatus.ready);
    expect(cubit.state.options, _options);
    expect(cubit.state.pageIndex, 0);
  });

  test('load() failure surfaces the Failure message', () async {
    when(() => repo.loadOptions())
        .thenThrow(const NetworkFailure('no net'));
    final FinishingCubit cubit = build();
    await cubit.load();
    expect(cubit.state.status, FinishingStatus.loadError);
    expect(cubit.state.error, 'no net');
  });

  test('multi-select toggles a language on and off', () async {
    final FinishingCubit cubit = build();
    await cubit.load();
    cubit.toggleLanguage('hindi');
    expect(cubit.state.prefs.languages, <String>{'hindi'});
    cubit.toggleLanguage('hindi');
    expect(cubit.state.prefs.languages, isEmpty);
  });

  test('single-select shift clears when the chosen chip is re-tapped', () async {
    final FinishingCubit cubit = build();
    await cubit.load();
    cubit.selectShift('day');
    expect(cubit.state.prefs.shift, 'day');
    cubit.selectShift('day');
    expect(cubit.state.prefs.shift, isNull);
  });

  test('addCity de-dupes case-insensitively; removeCity drops it', () async {
    final FinishingCubit cubit = build();
    await cubit.load();
    cubit.addCity('Gurugram');
    cubit.addCity('gurugram'); // dupe
    cubit.addCity('  '); // blank ignored
    expect(cubit.state.prefs.preferredCities, <String>['Gurugram']);
    cubit.removeCity('Gurugram');
    expect(cubit.state.prefs.preferredCities, isEmpty);
  });

  test('page navigation is bounded', () async {
    final FinishingCubit cubit = build();
    await cubit.load();
    cubit.previousPage(); // already first — no-op
    expect(cubit.state.pageIndex, 0);
    for (int i = 0; i < 10; i++) {
      cubit.nextPage();
    }
    expect(cubit.state.pageIndex, FinishingPage.values.length - 1);
    expect(cubit.state.isLastPage, isTrue);
  });

  test('the employer list caps at four', () async {
    final FinishingCubit cubit = build();
    await cubit.load();
    for (int i = 0; i < 6; i++) {
      cubit.addEmployer();
    }
    expect(cubit.state.employments.length, kMaxEmployers);
  });

  test('languages cap at six — a seventh tick is ignored, untick still works',
      () async {
    final FinishingCubit cubit = build();
    await cubit.load();
    expect(kFinishingMaxLanguages, 6);
    for (int i = 0; i < 6; i++) {
      cubit.toggleLanguage('lang$i');
    }
    expect(cubit.state.prefs.languages, hasLength(6));
    cubit.toggleLanguage('lang6');
    expect(cubit.state.prefs.languages, hasLength(6),
        reason: 'a seventh language must never reach the PUT as a 400');
    cubit.toggleLanguage('lang0');
    expect(cubit.state.prefs.languages, hasLength(5));
    cubit.toggleLanguage('lang6');
    expect(cubit.state.prefs.languages, hasLength(6));
    expect(cubit.state.prefs.languages, contains('lang6'));
  });

  test('submit persists prefs + non-blank employers, then done', () async {
    final FinishingCubit cubit = build();
    await cubit.load();
    cubit.toggleLanguage('hindi');
    cubit.selectJobType('permanent');
    cubit.addEmployer();
    cubit.updateEmployer(
      0,
      const EmploymentEntry(employerName: 'Acme', roleLabel: 'Fitter'),
    );
    cubit.addEmployer(); // a wholly-blank trailing card — must be dropped

    await cubit.submit();

    expect(cubit.state.status, FinishingStatus.done);
    final List<EmploymentEntry> sent =
        verify(() => repo.saveEmployment(captureAny())).captured.single
            as List<EmploymentEntry>;
    expect(sent, hasLength(1)); // blank card dropped
    expect(sent.single.employerName, 'Acme');
    verify(() => repo.saveWorkPreferences(any())).called(1);
  });

  test('a partially-typed employer blocks submit with an inline hint', () async {
    final FinishingCubit cubit = build();
    await cubit.load();
    cubit.addEmployer();
    cubit.updateEmployer(
      0,
      const EmploymentEntry(employerName: 'Acme', roleLabel: ''), // no role
    );
    await cubit.submit();
    expect(cubit.state.submitError, FinishingCubit.kIncompleteEmployerMessage);
    expect(cubit.state.status, FinishingStatus.ready);
    verifyNever(() => repo.saveWorkPreferences(any()));
  });

  test('#1298 salary + education setters flow into the submitted body',
      () async {
    final FinishingCubit cubit = build();
    await cubit.load();
    cubit.setSalaryMax(25000);
    cubit.selectCredential('iti');
    cubit.selectCouncil('ncvt');
    cubit.setEducationYear(2018);
    cubit.setInstitute('  Govt. ITI, Faridabad  ');
    expect(cubit.state.prefs.educationInstitute, 'Govt. ITI, Faridabad'); // trimmed

    await cubit.submit();

    final WorkPreferences prefs =
        verify(() => repo.saveWorkPreferences(captureAny())).captured.single
            as WorkPreferences;
    final Map<String, dynamic> body = prefs.toUpdateBody();
    expect(body['salary_expected_max'], 25000);
    expect(body['education_credential'], 'iti');
    expect(body['education_council'], 'ncvt');
    expect(body['education_year'], 2018);
    expect(body['education_institute'], 'Govt. ITI, Faridabad');
  });

  test('#1298 credential re-tap clears it; a blank institute becomes null',
      () async {
    final FinishingCubit cubit = build();
    await cubit.load();
    cubit.selectCredential('iti');
    cubit.selectCredential('iti'); // re-tap clears
    expect(cubit.state.prefs.educationCredential, isNull);
    cubit.setInstitute('   ');
    expect(cubit.state.prefs.educationInstitute, isNull);
  });

  test('a bad-city 400 keeps the worker on the form with the reason', () async {
    when(() => repo.saveWorkPreferences(any()))
        .thenThrow(const InvalidRequestFailure('Gurgram nahi mila'));
    final FinishingCubit cubit = build();
    await cubit.load();
    cubit.addCity('Gurgram');
    await cubit.submit();
    expect(cubit.state.status, FinishingStatus.ready);
    expect(cubit.state.submitError, 'Gurgram nahi mila');
    verifyNever(() => repo.saveEmployment(any())); // never reached the 2nd write
  });

  // "Ask once, skip if known": what the chat already asked is not a page here.
  test('a page whose fact the chat already recorded is skipped', () async {
    final FinishingCubit cubit = FinishingCubit(
      repo,
      knownFacts: InMemoryKnownWorkerFactsStore(
          <WorkerFact>[WorkerFact.preferredCities, WorkerFact.salary]),
    );
    await cubit.load();

    expect(cubit.state.pages, hasLength(FinishingPage.values.length - 2));
    expect(cubit.state.pages, isNot(contains(FinishingPage.cities)));
    expect(cubit.state.pages, isNot(contains(FinishingPage.salary)));
    for (int i = 0; i < 10; i++) {
      cubit.nextPage();
    }
    expect(cubit.state.page, FinishingPage.history);
    expect(cubit.state.isLastPage, isTrue);
  });

  test('an untouched work history is never sent (the PUT replaces it all)',
      () async {
    final FinishingCubit cubit = build();
    await cubit.load();
    cubit.toggleLanguage('hindi');

    await cubit.submit();

    expect(cubit.state.status, FinishingStatus.done);
    verifyNever(() => repo.saveEmployment(any()));
  });

  test('adding then removing every employer still sends the empty list',
      () async {
    final FinishingCubit cubit = build();
    await cubit.load();
    cubit.addEmployer();
    cubit.removeEmployer(0);

    await cubit.submit();

    final List<EmploymentEntry> sent =
        verify(() => repo.saveEmployment(captureAny())).captured.single
            as List<EmploymentEntry>;
    expect(sent, isEmpty, reason: '"I have none" is a real answer');
  });

  /// #1575 — `/finishing` renders net-new-only from the session fill view.
  group('settled-vs-missing fill view', () {
  SessionFillDto fill({
    List<SessionFillEntryDto> entries = const <SessionFillEntryDto>[],
    List<String> settled = const <String>[],
  }) =>
      SessionFillDto(entries: entries, settled: settled);

  SessionFillEntryDto entry(
    String fact, {
    String status = 'answered',
    bool dropped = false,
  }) =>
      SessionFillEntryDto(
        fact: fact,
        questionKey: fact,
        status: status,
        source: 'chat',
        droppedByProjector: dropped,
        isCore: false,
      );

  test('settled languages + work_types are hidden after load', () async {
    when(() => repo.loadSessionFill()).thenAnswer((_) async => fill(
          settled: const <String>['languages', 'shift', 'work_types'],
        ));
    final FinishingCubit cubit = build();
    await cubit.load();

    expect(cubit.state.status, FinishingStatus.ready);
    expect(cubit.state.pages, isNot(contains(FinishingPage.languages)));
    // shift settled AND the multi settled: the whole type page goes.
    expect(cubit.state.pages, isNot(contains(FinishingPage.shiftAndType)));
    // Everything else still shows.
    expect(cubit.state.pages, contains(FinishingPage.documents));
    expect(cubit.state.pages, contains(FinishingPage.history));
  });

  test('a declined fact counts as settled and is never re-asked', () async {
    // The server reports declines inside `settled`; the client cannot and
    // must not distinguish them from answers — both hide the page.
    when(() => repo.loadSessionFill()).thenAnswer((_) async => fill(
          entries: <SessionFillEntryDto>[entry('preferred_locations', status: 'declined')],
          settled: const <String>['preferred_locations'],
        ));
    final FinishingCubit cubit = build();
    await cubit.load();

    expect(cubit.state.pages, isNot(contains(FinishingPage.cities)));
  });

  test('a projector-dropped answer stays collectable', () async {
    when(() => repo.loadSessionFill()).thenAnswer((_) async => fill(
          entries: <SessionFillEntryDto>[
            entry('languages', status: 'missing', dropped: true),
          ],
        ));
    final FinishingCubit cubit = build();
    await cubit.load();

    // Missing is NOT settled: the page shows so the answer can be re-added.
    expect(cubit.state.pages, contains(FinishingPage.languages));
  });

  test('an empty fill view shows the full list (no false hiding)', () async {
    when(() => repo.loadSessionFill())
        .thenAnswer((_) async => fill());
    final FinishingCubit cubit = build();
    await cubit.load();

    expect(cubit.state.pages, hasLength(FinishingPage.values.length));
  });

  test('a failed fill read fails open to the full list', () async {
    when(() => repo.loadSessionFill()).thenThrow(Exception('2G blip'));
    final FinishingCubit cubit = build();
    await cubit.load();

    // The form itself must never strand on an informational read.
    expect(cubit.state.status, FinishingStatus.ready);
    expect(cubit.state.pages, hasLength(FinishingPage.values.length));
  });

  test('no session (form road) behaves exactly as before', () async {
    final FinishingCubit cubit = build();
    await cubit.load();

    expect(cubit.state.settledFacts, isEmpty);
    expect(cubit.state.fillEntries, isEmpty);
    expect(cubit.state.pages, hasLength(FinishingPage.values.length));
  });

  group('gapNoteForPage', () {
    test('dropped answers get the unusable-not-unanswered copy', () {
      expect(
        gapNoteForPage(FinishingPage.languages, <SessionFillEntryDto>[
          entry('languages', status: 'missing', dropped: true),
        ]),
        'Hum ye jawaab use nahi kar paaye — phir se jodein.',
      );
    });

    test('served-and-skipped facts get the unanswered copy', () {
      expect(
        gapNoteForPage(FinishingPage.languages, <SessionFillEntryDto>[
          entry('languages', status: 'unanswered'),
        ]),
        'Ye sawaal pehle chhoot gaya tha — ab jawaab dein.',
      );
    });

    test('never-asked facts get no note — the question is the ask', () {
      expect(
        gapNoteForPage(FinishingPage.languages, <SessionFillEntryDto>[
          entry('languages', status: 'missing'),
        ]),
        isNull,
      );
    });

    test('entries for other pages do not leak a note here', () {
      expect(
        gapNoteForPage(FinishingPage.languages, <SessionFillEntryDto>[
          entry('shift', status: 'unanswered'),
        ]),
        isNull,
      );
    });

    test('the history page never carries a note', () {
      expect(gapNoteForPage(FinishingPage.history, <SessionFillEntryDto>[]),
          isNull);
    });
  });
});
}
