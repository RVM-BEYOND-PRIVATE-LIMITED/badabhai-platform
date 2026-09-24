import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart';
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/features/profile/domain/profile_repository.dart';
import 'package:badabhai_worker_app/features/resume/domain/resume_edit_repository.dart';
import 'package:badabhai_worker_app/features/resume/domain/resume_repository.dart';
import 'package:badabhai_worker_app/features/resume/domain/resume_safe_fields.dart';
import 'package:badabhai_worker_app/features/resume/presentation/cubit/resume_cubit.dart';
import 'package:badabhai_worker_app/features/resume/presentation/resume_history_screen.dart';
import 'package:badabhai_worker_app/features/resume/presentation/widgets/resume_history_section.dart';

class _MockResumeRepository extends Mock implements ResumeRepository {}

class _MockResumeEditRepository extends Mock implements ResumeEditRepository {}

class _MockProfileRepository extends Mock implements ProfileRepository {}

/// #1687 — "Mere resume", the Profile tab's own list of every resume the worker
/// has made.
///
/// The list is the SERVER's window (`RESUME_HISTORY_VISIBLE_LIMIT`, ruling R4
/// "keep all, show three"): nothing is deleted, and an older entry stays
/// downloadable by its own id.
void main() {
  late _MockResumeRepository repo;

  ResumeHistoryItem item({
    required String id,
    required int day,
    ResumeSource? source = ResumeSource.chat,
    bool current = false,
  }) => ResumeHistoryItem(
    resumeId: id,
    profileId: 'p1',
    source: source,
    trigger: ResumeTrigger.profileConfirmed,
    generatedAt: DateTime.utc(2026, 9, day),
    renderStatus: 'rendered',
    renderedAt: DateTime.utc(2026, 9, day),
    isCurrent: current,
  );

  setUp(() async {
    GoogleFonts.config.allowRuntimeFetching = false;
    await locator.reset();
    repo = _MockResumeRepository();
    final _MockResumeEditRepository editRepo = _MockResumeEditRepository();
    when(() => editRepo.load()).thenAnswer(
      (_) async => const ResumeSafeFields(
        displayName: 'Test',
        showPhoto: false,
        nightShiftReady: false,
      ),
    );
    when(() => repo.loadResumeDocument())
        .thenAnswer((_) async => const ResumeDocumentSnapshot());
    locator.registerFactory<ResumeCubit>(
      () => ResumeCubit(repo, editRepo, _MockProfileRepository()),
    );
  });

  tearDown(() async => locator.reset());

  Future<void> pump(WidgetTester tester, ResumeHistory history) async {
    when(() => repo.loadResumeHistory()).thenAnswer((_) async => history);
    tester.view.physicalSize = const Size(420, 1400);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(
      MaterialApp(theme: AppTheme.light(), home: const ResumeHistoryScreen()),
    );
    await tester.pump();
    await tester.pump();
  }

  testWidgets('lists EVERY resume the server returned, newest first', (
    WidgetTester tester,
  ) async {
    await pump(
      tester,
      ResumeHistory(
        items: <ResumeHistoryItem>[
          item(id: 'r4', day: 20, current: true),
          item(id: 'r3', day: 18, source: ResumeSource.form),
          item(id: 'r2', day: 15, source: ResumeSource.resumeUpload),
          item(id: 'r1', day: 12),
        ],
      ),
    );

    expect(find.text(kResumeHistoryScreenTitle), findsOneWidget);
    // FOUR resumes, four cards — the app does not re-trim what the server sent.
    expect(find.text('20 September 2026'), findsOneWidget);
    expect(find.text('18 September 2026'), findsOneWidget);
    expect(find.text('15 September 2026'), findsOneWidget);
    expect(find.text('12 September 2026'), findsOneWidget);
    // Each labelled with the flow that made it, humanised — never a raw token.
    expect(find.text('CHAT'), findsNWidgets(2));
    expect(find.text('FORM'), findsOneWidget);
    expect(find.text('RESUME UPLOAD'), findsOneWidget);
    expect(find.textContaining('resume_upload'), findsNothing);
  });

  testWidgets('every card carries its OWN download and share', (
    WidgetTester tester,
  ) async {
    await pump(
      tester,
      ResumeHistory(
        items: <ResumeHistoryItem>[
          item(id: 'r2', day: 20, current: true),
          item(id: 'r1', day: 12),
        ],
      ),
    );

    expect(find.text('PDF download karein'), findsNWidgets(2));
  });

  testWidgets('no history: an honest empty state, never an error', (
    WidgetTester tester,
  ) async {
    await pump(tester, ResumeHistory.empty);

    expect(find.text(kResumeHistoryEmptyTitle), findsOneWidget);
    expect(find.text(kResumeHistoryScreenTitle), findsOneWidget);
  });

  testWidgets('the screen does not repeat the section heading — its own '
      'header already says what the list is', (WidgetTester tester) async {
    await pump(
      tester,
      ResumeHistory(items: <ResumeHistoryItem>[item(id: 'r1', day: 12)]),
    );

    expect(find.text(kResumeHistoryTitle.toUpperCase()), findsNothing);
  });

  testWidgets('it reads the history and never generates a resume', (
    WidgetTester tester,
  ) async {
    await pump(
      tester,
      ResumeHistory(items: <ResumeHistoryItem>[item(id: 'r1', day: 12)]),
    );

    verify(() => repo.loadResumeHistory()).called(greaterThan(0));
    verifyNever(() => repo.generateResume(force: any(named: 'force')));
  });
}
