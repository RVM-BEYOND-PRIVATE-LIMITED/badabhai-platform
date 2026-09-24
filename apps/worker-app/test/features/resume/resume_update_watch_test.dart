import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart';
import 'package:badabhai_worker_app/features/profile/domain/profile_repository.dart';
import 'package:badabhai_worker_app/features/profile_tab/domain/profile_summary.dart';
import 'package:badabhai_worker_app/features/profile_tab/domain/profile_summary_repository.dart';
import 'package:badabhai_worker_app/features/resume/domain/resume_edit_repository.dart';
import 'package:badabhai_worker_app/features/resume/domain/resume_repository.dart';
import 'package:badabhai_worker_app/features/resume/domain/resume_safe_fields.dart';
import 'package:badabhai_worker_app/features/resume/presentation/cubit/resume_cubit.dart';

class _MockResumeRepository extends Mock implements ResumeRepository {}

class _MockResumeEditRepository extends Mock implements ResumeEditRepository {}

class _MockProfileRepository extends Mock implements ProfileRepository {}

class _MockProfileSummaryRepository extends Mock
    implements ProfileSummaryRepository {}

/// #1688 — waiting for an update the worker accepted in chat, and the
/// document-poll bug that made a forced re-render show the OLD document.
///
/// Two separate failures, one file, because they are the same question asked
/// twice: "has the server's answer actually MOVED, or am I looking at what was
/// already there?"
void main() {
  late _MockResumeRepository repo;
  late _MockResumeEditRepository editRepo;
  late _MockProfileRepository profileRepo;
  late _MockProfileSummaryRepository summaryRepo;

  ResumeHistoryItem item({
    String id = 'r1',
    bool current = true,
    String status = 'rendered',
  }) => ResumeHistoryItem(
    resumeId: id,
    profileId: 'p1',
    source: ResumeSource.chat,
    trigger: ResumeTrigger.chatUpdateAccepted,
    generatedAt: DateTime.utc(2026, 9, 24),
    renderStatus: status,
    renderedAt: DateTime.utc(2026, 9, 24),
    isCurrent: current,
  );

  ResumeHistory pending() => ResumeHistory(
    items: <ResumeHistoryItem>[item(id: 'r-old')],
    pendingUpdate: PendingUpdate(
      requestedAt: DateTime.utc(2026, 9, 24),
      status: 'in_progress',
    ),
  );

  ResumeCubit cubit() => ResumeCubit(
    repo,
    editRepo,
    profileRepo,
    profileSummaryRepository: summaryRepo,
  );

  setUp(() {
    repo = _MockResumeRepository();
    editRepo = _MockResumeEditRepository();
    profileRepo = _MockProfileRepository();
    summaryRepo = _MockProfileSummaryRepository();
    when(() => editRepo.load()).thenAnswer(
      (_) async => const ResumeSafeFields(
        displayName: 'Test',
        showPhoto: true,
        nightShiftReady: false,
      ),
    );
    when(() => summaryRepo.summary()).thenAnswer(
      (_) async =>
          const ProfileSummary(tradeLabel: 'Welder', strengthSignals: 0),
    );
    when(() => repo.generateResume()).thenAnswer((_) async => 'RESUME');
    when(
      () => repo.loadResumeDocument(),
    ).thenAnswer((_) async => const ResumeDocumentSnapshot());
    when(
      () => repo.loadResumeHistory(),
    ).thenAnswer((_) async => ResumeHistory.empty);
    ResumeCubit.documentPollMaxAttempts = 1;
    ResumeCubit.documentPollInterval = Duration.zero;
    // The polling seams, zeroed: a real 3s backoff inside a test leaves a
    // pending Timer and fails the binding, not the assertion.
    ResumeCubit.updatePollInitial = Duration.zero;
    ResumeCubit.updatePollMax = Duration.zero;
    ResumeCubit.updateWatchBudget = const Duration(minutes: 3);
  });

  tearDown(() {
    ResumeCubit.documentPollMaxAttempts = 6;
    ResumeCubit.documentPollInterval = const Duration(seconds: 2);
    ResumeCubit.updatePollInitial = const Duration(seconds: 3);
    ResumeCubit.updatePollMax = const Duration(seconds: 10);
    ResumeCubit.updateWatchBudget = const Duration(minutes: 3);
  });

  group('watchResumeUpdate', () {
    test('polls while in_progress and stops the moment the update LANDS, '
        'with the new resume re-read and no manual refresh', () async {
      int calls = 0;
      when(() => repo.loadResumeHistory()).thenAnswer((_) async {
        calls++;
        if (calls < 3) return pending();
        return ResumeHistory(items: <ResumeHistoryItem>[item(id: 'r-new')]);
      });
      when(() => repo.generateResume()).thenAnswer((_) async => 'NEW RESUME');

      final ResumeCubit c = cubit();
      await c.watchResumeUpdate();

      expect(calls, 3);
      expect(c.state.updateInProgress, isFalse);
      expect(c.state.updateLanded, isTrue);
      expect(c.state.history.items.single.resumeId, 'r-new');
      // The resume itself was re-read, so the tab is not left showing the one
      // the worker accepted an update away from.
      verify(() => repo.generateResume()).called(greaterThan(0));
      await c.close();
    });

    test(
      'a server-reported `failed` is terminal and surfaces as a failure',
      () async {
        when(() => repo.loadResumeHistory()).thenAnswer(
          (_) async => ResumeHistory(
            items: <ResumeHistoryItem>[item()],
            pendingUpdate: PendingUpdate(
              requestedAt: DateTime.utc(2026, 9, 24),
              status: 'failed',
            ),
          ),
        );

        final ResumeCubit c = cubit();
        await c.watchResumeUpdate();

        expect(c.state.updateFailed, isTrue);
        expect(c.state.updateInProgress, isFalse);
        verify(() => repo.loadResumeHistory()).called(1);
        await c.close();
      },
    );

    test('the CLIENT DEADLINE stops a server that never finishes — the app '
        'never spins forever', () async {
      ResumeCubit.updateWatchBudget = Duration.zero;
      when(() => repo.loadResumeHistory()).thenAnswer((_) async => pending());

      final ResumeCubit c = cubit();
      await c.watchResumeUpdate();

      expect(c.state.updateFailed, isTrue);
      // One real answer is still observed before giving up.
      verify(() => repo.loadResumeHistory()).called(1);
      await c.close();
    });

    test('an UNKNOWN pending status is not "in progress" — a future server '
        'value can never trap a worker on the waiting card', () async {
      when(() => repo.loadResumeHistory()).thenAnswer(
        (_) async => ResumeHistory(
          items: <ResumeHistoryItem>[item()],
          pendingUpdate: PendingUpdate(
            requestedAt: DateTime.utc(2026, 9, 24),
            status: 'paused_for_lunch',
          ),
        ),
      );

      final ResumeCubit c = cubit();
      await c.watchResumeUpdate();

      expect(c.state.updateInProgress, isFalse);
      expect(c.state.updateFailed, isFalse);
      await c.close();
    });

    test('a second watch cannot start while one is running', () async {
      when(() => repo.loadResumeHistory()).thenAnswer((_) async => pending());
      ResumeCubit.updateWatchBudget = Duration.zero;

      final ResumeCubit c = cubit();
      await Future.wait<void>(<Future<void>>[
        c.watchResumeUpdate(),
        c.watchResumeUpdate(),
      ]);

      verify(() => repo.loadResumeHistory()).called(1);
      await c.close();
    });

    test('loadHistory never fails the screen and carries the rest of the '
        'state forward', () async {
      when(() => repo.loadResumeHistory()).thenAnswer(
        (_) async => ResumeHistory(items: <ResumeHistoryItem>[item()]),
      );

      final ResumeCubit c = cubit();
      await c.generate();
      final String textBefore = c.state.resumeText;
      await c.loadHistory();

      expect(c.state.history.items, hasLength(1));
      expect(c.state.resumeText, textBefore);
      await c.close();
    });
  });

  group('_loadDocumentWithRetry baseline (the stale-document bug)', () {
    test('a FORCED re-render leaves the row `rendered` with the OLD document, '
        'so the poll waits for rendered_at to MOVE', () async {
      ResumeCubit.documentPollMaxAttempts = 5;
      final DateTime before = DateTime.utc(2026, 9, 24, 10);
      final DateTime after = DateTime.utc(2026, 9, 24, 10, 5);

      when(() => repo.generateResume()).thenAnswer((_) async => 'RESUME');
      int calls = 0;
      when(() => repo.loadResumeDocument()).thenAnswer((_) async {
        calls++;
        // The pre-write document, still `rendered`, for the first two polls —
        // exactly the shape that used to end the loop on attempt one.
        if (calls <= 3) {
          return ResumeDocumentSnapshot(
            document: const GenericResumeDocument(
              header: ResumeDocumentHeaderDto(name: 'OLD'),
            ),
            renderStatus: 'rendered',
            renderedAt: before,
          );
        }
        return ResumeDocumentSnapshot(
          document: const GenericResumeDocument(
            header: ResumeDocumentHeaderDto(name: 'NEW'),
          ),
          renderStatus: 'rendered',
          renderedAt: after,
        );
      });
      when(
        () => repo.setEmploymentDescriptionSource('e1', ownWords: true),
      ).thenAnswer((_) async {});

      final ResumeCubit c = cubit();
      await c.generate(); // seeds state.renderedAt = `before` (call 1)
      expect(c.state.renderedAt, before);

      await c.setEmploymentDescriptionSource('e1', ownWords: true);

      expect(
        c.state.document,
        isA<GenericResumeDocument>().having(
          (GenericResumeDocument d) => d.header.name,
          'header.name',
          'NEW',
        ),
      );
      expect(c.state.renderedAt, after);
      await c.close();
    });

    test('a caller with NO baseline keeps today\'s behaviour: it stops on the '
        'first usable document', () async {
      ResumeCubit.documentPollMaxAttempts = 5;
      int calls = 0;
      when(() => repo.loadResumeDocument()).thenAnswer((_) async {
        calls++;
        return ResumeDocumentSnapshot(
          document: const GenericResumeDocument(
            header: ResumeDocumentHeaderDto(name: 'OLD'),
          ),
          renderStatus: 'rendered',
          renderedAt: DateTime.utc(2026, 9, 24, 10),
        );
      });

      final ResumeCubit c = cubit();
      await c.generate();

      expect(calls, 1);
      await c.close();
    });
  });
}
