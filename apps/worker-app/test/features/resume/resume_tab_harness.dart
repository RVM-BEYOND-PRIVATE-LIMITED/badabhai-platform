import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart';
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/nav/tab_focus.dart';
import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/features/profile/domain/profile_repository.dart';
import 'package:badabhai_worker_app/features/profile_tab/domain/profile_summary.dart';
import 'package:badabhai_worker_app/features/profile_tab/domain/profile_summary_repository.dart';
import 'package:badabhai_worker_app/features/resume/domain/photo_repository.dart';
import 'package:badabhai_worker_app/features/resume/domain/resume_edit_repository.dart';
import 'package:badabhai_worker_app/features/resume/domain/resume_repository.dart';
import 'package:badabhai_worker_app/features/resume/domain/resume_safe_fields.dart';
import 'package:badabhai_worker_app/features/resume/presentation/cubit/resume_cubit.dart';
import 'package:badabhai_worker_app/features/resume/presentation/resume_preview_screen.dart';
import 'package:badabhai_worker_app/router.dart';

class MockResumeRepository extends Mock implements ResumeRepository {}

class MockResumeEditRepository extends Mock implements ResumeEditRepository {}

class MockProfileRepository extends Mock implements ProfileRepository {}

class MockPhotoRepository extends Mock implements PhotoRepository {}

/// R7's source for the DRAFT pill. [verified] is the backend's own
/// "profile confirmed" answer; [failing] makes the read throw, which must
/// leave the pill HIDDEN (unknown is never "draft").
class FakeProfileSummaryRepository implements ProfileSummaryRepository {
  FakeProfileSummaryRepository({this.verified, this.failing = false});

  final bool? verified;
  final bool failing;

  @override
  Future<ProfileSummary> summary({bool includeDisplayExtras = false}) async {
    if (failing) throw const NetworkFailure();
    return ProfileSummary(verified: verified ?? false, strengthSignals: 0);
  }
}

/// One route the tab actually pushed, and what it carried.
class PushedRoute {
  const PushedRoute(this.path, this.extra);

  final String path;
  final Object? extra;

  @override
  String toString() => 'PushedRoute($path, extra: $extra)';
}

/// The deterministic resume TEXT (ADR-0013's `Label: value` template) used for
/// the legacy / generic render path — the shape ai-service actually emits.
const String kLegacyResumeText = '''WORKER PROFILE (DRAFT)

Role: HMC Operator
Trade: HMC Machining
Experience: 10 years
Machines: Horizontal Machining Center (HMC)
Skills: Mitsubishi control operation, Tool offset setting
Education level: below_10
Current location: Faridabad
Expected salary: 24000 per month
Availability: Immediately''';

/// The Resume tab, wired the way the app wires it — one place, because the
/// data-rule suite and the responsive matrix must judge the SAME screen.
///
/// Everything is a real repository boundary behind a mock: the tab's own data
/// rules (hide a block with no data, never claim READY, never print a raw id)
/// are only meaningful against the shapes the server really sends.
class ResumeTabHarness {
  late MockResumeRepository repo;
  late MockResumeEditRepository editRepo;
  late MockPhotoRepository photoRepo;

  /// Every route pushed above /resume, in order.
  final List<PushedRoute> pushed = <PushedRoute>[];

  /// What the fake `/resume/edit` route pops when it is closed — `true` for a
  /// name change, `null` for a plain dismiss.
  bool? editPops;

  late GoRouter router;

  /// Wires the locator for ONE test.
  ///
  /// [resumeText] non-null takes the Building-screen handoff path
  /// (`showGenerated`), which is how a just-generated resume reaches the tab.
  /// Passing null instead exercises `generate()`, so [generateThrows] /
  /// [generateNeverResolves] can produce the failed / noProfile / loading
  /// states.
  Future<void> wire({
    String? resumeText = kLegacyResumeText,
    ResumeDocument? document,
    String? renderStatus,
    bool? profileConfirmed,
    bool profileStatusUnknown = false,
    String name = 'Suresh Yadav',
    bool showPhoto = false,
    bool hasPhoto = false,
    String? photoUrl,
    bool nightShiftReady = false,
    bool editLoadThrows = false,
    Object? generateThrows,
    bool generateNeverResolves = false,
    bool documentNeverResolves = false,
  }) async {
    GoogleFonts.config.allowRuntimeFetching = false;
    await locator.reset();
    pushed.clear();
    repo = MockResumeRepository();
    editRepo = MockResumeEditRepository();
    photoRepo = MockPhotoRepository();

    // The document poll is collapsed to a single attempt: a real 6x2s retry
    // would leave a pending Timer past the fixed pump counts these suites use.
    ResumeCubit.documentPollMaxAttempts = 1;
    ResumeCubit.documentPollInterval = Duration.zero;

    if (editLoadThrows) {
      when(() => editRepo.load()).thenThrow(const UnauthorizedFailure());
    } else {
      when(() => editRepo.load()).thenAnswer(
        (_) async => ResumeSafeFields(
          displayName: name,
          showPhoto: showPhoto,
          hasPhoto: hasPhoto,
          nightShiftReady: nightShiftReady,
        ),
      );
    }
    when(() => photoRepo.photoUrl()).thenAnswer((_) async => photoUrl);
    if (documentNeverResolves) {
      // Holds the tab in `awaitingDocument` — the loader a form-first worker
      // sees while the structured sheet is still being written server-side.
      final Completer<ResumeDocumentSnapshot> never =
          Completer<ResumeDocumentSnapshot>();
      when(() => repo.loadResumeDocument()).thenAnswer((_) => never.future);
    } else {
      when(() => repo.loadResumeDocument()).thenAnswer(
        (_) async => ResumeDocumentSnapshot(
          document: document,
          renderStatus: renderStatus,
        ),
      );
    }
    when(() => repo.reportShared(any())).thenAnswer((_) async {});
    if (generateNeverResolves) {
      final Completer<String> never = Completer<String>();
      when(
        () => repo.generateResume(force: any(named: 'force')),
      ).thenAnswer((_) => never.future);
    } else if (generateThrows != null) {
      when(
        () => repo.generateResume(force: any(named: 'force')),
      ).thenThrow(generateThrows);
    } else {
      when(
        () => repo.generateResume(force: any(named: 'force')),
      ).thenAnswer((_) async => resumeText ?? kLegacyResumeText);
    }

    final ProfileSummaryRepository summaryRepo = FakeProfileSummaryRepository(
      verified: profileConfirmed,
      failing: profileStatusUnknown || profileConfirmed == null,
    );
    locator.registerFactory<ResumeCubit>(
      () => ResumeCubit(
        repo,
        editRepo,
        MockProfileRepository(),
        // An unknown profile status is the DEFAULT here (no repository answer),
        // because that is production today for a worker whose summary read
        // fails — and the pill must stay hidden for them.
        profileSummaryRepository: summaryRepo,
      ),
    );
    locator.registerLazySingleton<TabFocus>(() => TabFocus());
    locator.registerFactory<ResumeEditRepository>(() => editRepo);
    locator.registerFactory<PhotoRepository>(() => photoRepo);
    this.resumeText = resumeText;
  }

  /// The handoff text, or null when the screen should generate.
  String? resumeText = kLegacyResumeText;

  /// Resets the cubit's static test seams. Call from `tearDown`.
  static Future<void> reset() async {
    ResumeCubit.documentPollMaxAttempts = 6;
    ResumeCubit.documentPollInterval = const Duration(seconds: 2);
    await locator.reset();
  }

  /// The screen alone, for the responsive matrix (which supplies its own app).
  Widget get screen => ResumePreviewScreen(initialResume: resumeText);

  /// The screen under a REAL GoRouter, so every navigation assertion is the
  /// navigation the app performs — `pushOnce` reads the live route stack, and
  /// the header's Feedback action reads `GoRouterState.of(context)`.
  Widget app() {
    router = GoRouter(
      initialLocation: Routes.resume,
      routes: <RouteBase>[
        GoRoute(
          path: Routes.resume,
          builder: (_, GoRouterState state) => screen,
        ),
        GoRoute(
          path: Routes.resumeEdit,
          builder: (BuildContext context, GoRouterState state) {
            pushed.add(PushedRoute(Routes.resumeEdit, state.extra));
            return _StubRoute(
              label: 'edit-stub',
              onClose: () => context.pop(editPops),
            );
          },
        ),
        GoRoute(
          path: Routes.alerts,
          builder: (_, GoRouterState state) {
            pushed.add(PushedRoute(Routes.alerts, state.extra));
            return const _StubRoute(label: 'alerts-stub');
          },
        ),
        GoRoute(
          path: Routes.feedback,
          builder: (_, GoRouterState state) {
            pushed.add(PushedRoute(Routes.feedback, state.extra));
            return const _StubRoute(label: 'feedback-stub');
          },
        ),
        GoRoute(
          path: Routes.consent,
          builder: (_, GoRouterState state) {
            pushed.add(PushedRoute(Routes.consent, state.extra));
            return const _StubRoute(label: 'consent-stub');
          },
        ),
      ],
    );
    return MaterialApp.router(theme: AppTheme.light(), routerConfig: router);
  }

  /// The path on TOP of the stack — what the worker is actually looking at.
  String get topPath =>
      router.routerDelegate.currentConfiguration.matches.last.matchedLocation;
}

/// A named destination that records nothing but its own presence.
class _StubRoute extends StatelessWidget {
  const _StubRoute({required this.label, this.onClose});

  final String label;
  final VoidCallback? onClose;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Text(label),
            if (onClose != null)
              TextButton(onPressed: onClose, child: const Text('close-stub')),
          ],
        ),
      ),
    );
  }
}
