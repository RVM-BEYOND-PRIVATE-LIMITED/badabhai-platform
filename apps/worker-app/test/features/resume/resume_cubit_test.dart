import 'package:bloc_test/bloc_test.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/features/resume/domain/resume_edit_repository.dart';
import 'package:badabhai_worker_app/features/resume/domain/resume_repository.dart';
import 'package:badabhai_worker_app/features/resume/domain/resume_safe_fields.dart';
import 'package:badabhai_worker_app/features/resume/presentation/cubit/resume_cubit.dart';

class MockResumeRepository extends Mock implements ResumeRepository {}

class MockResumeEditRepository extends Mock implements ResumeEditRepository {}

void main() {
  late MockResumeRepository repo;
  late MockResumeEditRepository editRepo;

  setUp(() {
    repo = MockResumeRepository();
    editRepo = MockResumeEditRepository();
    when(() => editRepo.load()).thenAnswer(
      (_) async => const ResumeSafeFields(
        displayName: 'Test',
        showPhoto: true,
        nightShiftReady: false,
      ),
    );
    // #1343 — the ORDINARY answer (no structured document yet). Tests below
    // that care about a real document override this per-test.
    when(() => repo.loadResumeDocument()).thenAnswer((_) async => null);
  });

  // bloc emits the first state even when it equals the initial `loading`.
  blocTest<ResumeCubit, ResumeState>(
    'generate success -> ready with the resume text',
    build: () {
      when(() => repo.generateResume()).thenAnswer((_) async => 'RESUME TEXT');
      return ResumeCubit(repo, editRepo);
    },
    act: (ResumeCubit c) => c.generate(),
    expect: () => const <ResumeState>[
      ResumeState(status: ResumeStatus.loading),
      ResumeState(
        status: ResumeStatus.ready,
        resumeText: 'RESUME TEXT',
        nightShiftReady: false,
      ),
    ],
    verify: (_) => verify(() => repo.generateResume()).called(1),
  );

  blocTest<ResumeCubit, ResumeState>(
    'generate failure -> failed (not a stuck spinner)',
    build: () {
      when(() => repo.generateResume()).thenThrow(const NetworkFailure());
      return ResumeCubit(repo, editRepo);
    },
    act: (ResumeCubit c) => c.generate(),
    expect: () => const <ResumeState>[
      ResumeState(status: ResumeStatus.loading),
      ResumeState(status: ResumeStatus.failed),
    ],
  );

  // #820 — a generate that returns 200 with no resume text must NOT paint the
  // "Resume taiyaar ✓" banner over a blank card and stick there. An empty body is
  // a generation failure; fail closed to the retry view.
  blocTest<ResumeCubit, ResumeState>(
    'generate with an EMPTY resume -> failed, never a blank ready (#820)',
    build: () {
      when(() => repo.generateResume()).thenAnswer((_) async => '');
      return ResumeCubit(repo, editRepo);
    },
    act: (ResumeCubit c) => c.generate(),
    expect: () => const <ResumeState>[
      ResumeState(status: ResumeStatus.loading),
      ResumeState(status: ResumeStatus.failed),
    ],
    verify: (_) {
      // The night-shift pref is never fetched for a resume that does not exist.
      verifyNever(() => editRepo.load());
    },
  );

  blocTest<ResumeCubit, ResumeState>(
    'generate with a WHITESPACE-only resume -> failed (#820)',
    build: () {
      when(() => repo.generateResume()).thenAnswer((_) async => '   \n\t  ');
      return ResumeCubit(repo, editRepo);
    },
    act: (ResumeCubit c) => c.generate(),
    expect: () => const <ResumeState>[
      ResumeState(status: ResumeStatus.loading),
      ResumeState(status: ResumeStatus.failed),
    ],
  );

  test('showGenerated("") -> failed, not a fake ready (#820)', () async {
    final ResumeCubit cubit = ResumeCubit(repo, editRepo);
    addTearDown(cubit.close);

    await cubit.showGenerated('');

    expect(cubit.state.status, ResumeStatus.failed);
    expect(cubit.state.resumeText, isEmpty);
  });

  test('a refresh that returns EMPTY keeps the resume already on screen (#820)',
      () async {
    when(() => repo.generateResume(force: any(named: 'force')))
        .thenAnswer((_) async => '');
    final ResumeCubit cubit = ResumeCubit(repo, editRepo);
    addTearDown(cubit.close);

    await cubit.showGenerated('good resume');
    await cubit.refresh();

    // A blank reused resume must not overwrite a readable one (stale beats blank).
    expect(cubit.state.status, ResumeStatus.ready);
    expect(cubit.state.resumeText, 'good resume');
  });

  test('a refresh that returns EMPTY with nothing good on screen -> failed (#820)',
      () async {
    when(() => repo.generateResume(force: any(named: 'force')))
        .thenAnswer((_) async => '');
    final ResumeCubit cubit = ResumeCubit(repo, editRepo);
    addTearDown(cubit.close);

    await cubit.refresh();

    expect(cubit.state.status, ResumeStatus.failed);
  });

  test('resolveDownloadUrl returns the signed url on success', () async {
    when(() => repo.resumeDownloadUrl())
        .thenAnswer((_) async => 'https://signed/u?token=x');
    final ResumeCubit cubit = ResumeCubit(repo, editRepo);
    expect(await cubit.resolveDownloadUrl(), 'https://signed/u?token=x');
    verify(() => repo.resumeDownloadUrl()).called(1);
  });

  test('resolveDownloadUrl PROPAGATES the Failure (so the launcher shows the '
      'real reason, not a blank generic line)', () {
    when(() => repo.resumeDownloadUrl()).thenThrow(const UnauthorizedFailure());
    final ResumeCubit cubit = ResumeCubit(repo, editRepo);
    expect(() => cubit.resolveDownloadUrl(), throwsA(isA<UnauthorizedFailure>()));
  });

  // T4 — the Resume tab refetches when it comes back into view. It must REUSE
  // the existing resume: a forced generate on every tab switch would overwrite
  // the row server-side, reset the PDF to 'pending', re-enqueue the render and
  // burn one of the worker's 5 daily generates — just for looking at the tab.
  group('tab-focus refresh (T4)', () {
    test('refresh NEVER forces a regenerate', () async {
      when(() => repo.generateResume(force: any(named: 'force')))
          .thenAnswer((_) async => 'resume text');
      final ResumeCubit cubit = ResumeCubit(repo, editRepo);
      addTearDown(cubit.close);

      await cubit.refresh();

      // force: false is the reuse path — the repo only POSTs generate when there
      // genuinely is no resume yet.
      verify(() => repo.generateResume()).called(1);
      verifyNever(() => repo.generateResume(force: true));
    });

    test('a failed refresh keeps the resume already on screen', () async {
      when(() => repo.generateResume(force: any(named: 'force')))
          .thenThrow(const NetworkFailure());
      final ResumeCubit cubit = ResumeCubit(repo, editRepo);
      addTearDown(cubit.close);

      // The worker is reading a resume; a background blip must not replace it
      // with an error screen.
      await cubit.showGenerated('good resume');
      await cubit.refresh();

      expect(cubit.state.status, ResumeStatus.ready);
      expect(cubit.state.resumeText, 'good resume');
    });

    test('a failed refresh DOES surface when nothing good is on screen',
        () async {
      when(() => repo.generateResume(force: any(named: 'force')))
          .thenThrow(const NetworkFailure());
      final ResumeCubit cubit = ResumeCubit(repo, editRepo);
      addTearDown(cubit.close);

      await cubit.refresh();

      expect(cubit.state.status, ResumeStatus.failed);
    });

    test('refresh does not emit a spinner over a readable resume', () async {
      when(() => repo.generateResume(force: any(named: 'force')))
          .thenAnswer((_) async {
        await Future<void>.delayed(const Duration(milliseconds: 20));
        return 'fresh';
      });
      final ResumeCubit cubit = ResumeCubit(repo, editRepo);
      addTearDown(cubit.close);
      await cubit.showGenerated('stale');

      final List<ResumeStatus> seen = <ResumeStatus>[];
      final sub = cubit.stream.listen((ResumeState s) => seen.add(s.status));
      addTearDown(sub.cancel);

      await cubit.refresh();

      expect(seen, isNot(contains(ResumeStatus.loading)),
          reason: 'the worker must not watch their resume flash to a spinner');
      expect(cubit.state.resumeText, 'fresh');
    });

    test('overlapping loads are ignored', () async {
      int calls = 0;
      when(() => repo.generateResume(force: any(named: 'force')))
          .thenAnswer((_) async {
        calls++;
        await Future<void>.delayed(const Duration(milliseconds: 50));
        return 'resume text';
      });
      final ResumeCubit cubit = ResumeCubit(repo, editRepo);
      addTearDown(cubit.close);

      // Tab focus can fire while the create:-time generate is still in flight.
      await Future.wait<void>(<Future<void>>[cubit.generate(), cubit.refresh()]);

      expect(calls, 1, reason: 'the second load must be ignored, not stacked');
    });
  });

  // #1343 — the cubit best-effort loads GET /resume/document alongside the
  // existing resume text, and NEVER lets a hiccup there cost the worker the
  // text/night-shift state that already resolved.
  group('structured document (#1343)', () {
    const ResumeDocument tradeSheet = TradeSheetResumeDocument(
      header: ResumeDocumentHeaderDto(name: 'Suresh Yadav'),
      trade: 'cnc_turner',
    );

    test('generate() carries the repo\'s document onto ready state', () async {
      when(() => repo.generateResume()).thenAnswer((_) async => 'RESUME TEXT');
      when(() => repo.loadResumeDocument())
          .thenAnswer((_) async => tradeSheet);
      final ResumeCubit cubit = ResumeCubit(repo, editRepo);
      addTearDown(cubit.close);

      await cubit.generate();

      expect(cubit.state.status, ResumeStatus.ready);
      expect(cubit.state.document, same(tradeSheet));
    });

    test('a document fetch that THROWS never costs the worker their resume '
        'text (belt-and-suspenders, matching the night-shift pref)', () async {
      when(() => repo.generateResume()).thenAnswer((_) async => 'RESUME TEXT');
      when(() => repo.loadResumeDocument())
          .thenThrow(const NetworkFailure());
      final ResumeCubit cubit = ResumeCubit(repo, editRepo);
      addTearDown(cubit.close);

      await cubit.generate();

      expect(cubit.state.status, ResumeStatus.ready);
      expect(cubit.state.resumeText, 'RESUME TEXT');
      expect(cubit.state.document, isNull);
    });

    test('showGenerated() also loads the structured document', () async {
      when(() => repo.loadResumeDocument())
          .thenAnswer((_) async => tradeSheet);
      final ResumeCubit cubit = ResumeCubit(repo, editRepo);
      addTearDown(cubit.close);

      await cubit.showGenerated('good resume');

      expect(cubit.state.document, same(tradeSheet));
    });

    test('refreshNightShift() PRESERVES the document — a prefs-only reload '
        'must not blank a document that was already on screen', () async {
      when(() => repo.loadResumeDocument())
          .thenAnswer((_) async => tradeSheet);
      final ResumeCubit cubit = ResumeCubit(repo, editRepo);
      addTearDown(cubit.close);
      await cubit.showGenerated('good resume');
      expect(cubit.state.document, same(tradeSheet));

      await cubit.refreshNightShift();

      expect(cubit.state.document, same(tradeSheet));
    });

    test('refresh() re-fetches and can pick up a document that appeared '
        'since the last load', () async {
      when(() => repo.generateResume(force: any(named: 'force')))
          .thenAnswer((_) async => 'resume text');
      when(() => repo.loadResumeDocument())
          .thenAnswer((_) async => null);
      final ResumeCubit cubit = ResumeCubit(repo, editRepo);
      addTearDown(cubit.close);
      await cubit.generate();
      expect(cubit.state.document, isNull);

      when(() => repo.loadResumeDocument())
          .thenAnswer((_) async => tradeSheet);
      await cubit.refresh();

      expect(cubit.state.document, same(tradeSheet));
    });
  });

  // #1353/#1354 — the worker's choice of which text prints for one
  // work-history entry. UNLIKE reportShared, this NEVER swallows a failure
  // (mirrors resolveDownloadUrl).
  group('setEmploymentDescriptionSource', () {
    const ResumeDocument tradeSheet = TradeSheetResumeDocument(
      header: ResumeDocumentHeaderDto(name: 'Suresh Yadav'),
      trade: 'cnc_turner',
    );
    const ResumeDocument reloadedSheet = TradeSheetResumeDocument(
      header: ResumeDocumentHeaderDto(name: 'Suresh Yadav'),
      trade: 'cnc_turner',
      employmentsMore: 'reloaded',
    );

    blocTest<ResumeCubit, ResumeState>(
      'success -> PUTs the choice then RE-FETCHES the document, keeping the '
      'resume text and night-shift pref already on screen',
      build: () {
        when(() => repo.setEmploymentDescriptionSource(any(),
                ownWords: any(named: 'ownWords')))
            .thenAnswer((_) async {});
        when(() => repo.loadResumeDocument())
            .thenAnswer((_) async => reloadedSheet);
        return ResumeCubit(repo, editRepo);
      },
      seed: () => const ResumeState(
        status: ResumeStatus.ready,
        resumeText: 'good resume',
        nightShiftReady: true,
        document: tradeSheet,
      ),
      act: (ResumeCubit c) =>
          c.setEmploymentDescriptionSource('emp-1', ownWords: true),
      expect: () => const <ResumeState>[
        ResumeState(
          status: ResumeStatus.ready,
          resumeText: 'good resume',
          nightShiftReady: true,
          document: reloadedSheet,
        ),
      ],
      verify: (_) {
        verify(() => repo.setEmploymentDescriptionSource('emp-1',
            ownWords: true)).called(1);
        verify(() => repo.loadResumeDocument()).called(1);
      },
    );

    blocTest<ResumeCubit, ResumeState>(
      'ownWords: false is passed straight through — reversible in both '
      'directions',
      build: () {
        when(() => repo.setEmploymentDescriptionSource(any(),
                ownWords: any(named: 'ownWords')))
            .thenAnswer((_) async {});
        when(() => repo.loadResumeDocument())
            .thenAnswer((_) async => reloadedSheet);
        return ResumeCubit(repo, editRepo);
      },
      act: (ResumeCubit c) =>
          c.setEmploymentDescriptionSource('emp-1', ownWords: false),
      expect: () => const <ResumeState>[
        ResumeState(document: reloadedSheet),
      ],
      verify: (_) {
        verify(() => repo.setEmploymentDescriptionSource('emp-1',
            ownWords: false)).called(1);
      },
    );

    test(
        'a write failure PROPAGATES the Failure — never a silent no-op over '
        'a sentence carrying the worker\'s name', () async {
      when(() => repo.setEmploymentDescriptionSource(any(),
              ownWords: any(named: 'ownWords')))
          .thenThrow(const ServerFailure(404));
      final ResumeCubit cubit = ResumeCubit(repo, editRepo);
      addTearDown(cubit.close);

      await expectLater(
        cubit.setEmploymentDescriptionSource('emp-1', ownWords: true),
        throwsA(isA<ServerFailure>()),
      );
      // The write never even reached the point of reloading.
      verifyNever(() => repo.loadResumeDocument());
    });

    test(
        'a write success but a hiccupping reload KEEPS the document already '
        'on screen (mirrors refreshNightShift: stale beats blanked)',
        () async {
      when(() => repo.setEmploymentDescriptionSource(any(),
              ownWords: any(named: 'ownWords')))
          .thenAnswer((_) async {});
      when(() => repo.loadResumeDocument())
          .thenAnswer((_) async => tradeSheet);
      final ResumeCubit cubit = ResumeCubit(repo, editRepo);
      addTearDown(cubit.close);
      await cubit.showGenerated('good resume');
      expect(cubit.state.document, same(tradeSheet));

      when(() => repo.loadResumeDocument()).thenThrow(const NetworkFailure());
      await cubit.setEmploymentDescriptionSource('emp-1', ownWords: true);

      expect(cubit.state.document, same(tradeSheet));
      expect(cubit.state.status, ResumeStatus.ready);
      expect(cubit.state.resumeText, 'good resume');
    });
  });
}
