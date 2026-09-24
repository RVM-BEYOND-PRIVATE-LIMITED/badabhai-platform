import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/widgets/kit/kit_header_actions.dart';
import 'package:badabhai_worker_app/core/widgets/onboarding/brand_badge.dart';
import 'package:badabhai_worker_app/features/profile/domain/profile_repository.dart';
import 'package:badabhai_worker_app/features/profile/presentation/cubit/profile_cubit.dart';
import 'package:badabhai_worker_app/features/profile/presentation/profile_preview_screen.dart';
import 'package:badabhai_worker_app/features/profile_tab/domain/profile_summary.dart';
import 'package:badabhai_worker_app/features/profile_tab/domain/profile_summary_repository.dart';

import '../../support/kit_matrix.dart';

class _MockProfileRepository extends Mock implements ProfileRepository {}

class _MockSummaryRepository extends Mock implements ProfileSummaryRepository {}

/// The `extracting` wait — the screen a worker stares at while the server turns
/// their interview into a profile.
///
/// It is PINNED because it is a paced drawing over an opaque call: the rows
/// must never run to "all done" (that would claim a finish the server has not
/// reported), and nothing here may be settled with `pumpAndSettle` — the
/// avatar's ripple loops for as long as the wait does.
void main() {
  /// Extraction that NEVER resolves, so the panel stays on screen.
  void registerStuckGraph() {
    final _MockProfileRepository repo = _MockProfileRepository();
    final _MockSummaryRepository summaryRepo = _MockSummaryRepository();
    when(
      () => repo.extractProfile(),
    ).thenAnswer((_) => Completer<String>().future);
    when(
      () => summaryRepo.summary(),
    ).thenAnswer((_) => Completer<ProfileSummary>().future);
    locator.registerFactory<ProfileCubit>(
      () => ProfileCubit(repo, summaryRepo),
    );
  }

  setUp(() async {
    await locator.reset();
    registerStuckGraph();
  });

  tearDown(() async => locator.reset());

  /// Past the entrance + the whole pacing window, without settling.
  Future<void> pumpPaced(WidgetTester tester) async {
    await tester.pump();
    await tester.pump(const Duration(seconds: 3));
  }

  testWidgets('draws the avatar, the headline, the three rows and the tip', (
    WidgetTester tester,
  ) async {
    setKitSurface(tester, const Size(390, 844));
    await tester.pumpWidget(kitTestApp(const ProfilePreviewScreen()));
    await pumpPaced(tester);

    expect(find.byIcon(Icons.person_outline_rounded), findsOneWidget);
    expect(find.text(kPreparingProfileTitle), findsOneWidget);
    expect(find.text(kPreparingProfileCaption), findsOneWidget);
    for (final String step in kPreparingProfileSteps) {
      expect(find.text(step), findsOneWidget);
    }
    expect(find.text(kPreparingProfileTipTitle.toUpperCase()), findsOneWidget);
    expect(find.text(kPreparingProfileTipText), findsOneWidget);
  });

  testWidgets('the header carries the Feedback WORD, never the brand lockup', (
    WidgetTester tester,
  ) async {
    setKitSurface(tester, const Size(390, 844));
    await tester.pumpWidget(kitTestApp(const ProfilePreviewScreen()));
    await pumpPaced(tester);

    // The lockup is gone from this screen's header, and the slot it held now
    // carries Feedback — the floating pill is hidden on /profiling for exactly
    // that reason (`feedback_fab_test.dart` pins the other half).
    expect(find.byType(BrandBadge), findsNothing);
    expect(find.byType(KitFeedbackTextAction), findsOneWidget);
    expect(find.text('FEEDBACK'), findsOneWidget);
  });

  testWidgets('the ticker never runs to "all done" — the last row stays '
      'pending and one row is live', (WidgetTester tester) async {
    setKitSurface(tester, const Size(390, 844));
    await tester.pumpWidget(kitTestApp(const ProfilePreviewScreen()));
    await pumpPaced(tester);

    // One ticked row, one live spinner — never three ticks.
    expect(find.byIcon(Icons.check_rounded), findsOneWidget);
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
  });

  testWidgets('survives 320x568 @2.0 without overflowing', (
    WidgetTester tester,
  ) async {
    setKitSurface(tester, const Size(320, 568));
    await tester.pumpWidget(
      kitTestApp(const ProfilePreviewScreen(), textScale: 2.0),
    );
    await pumpPaced(tester);

    expect(tester.takeException(), isNull);
    expect(find.text(kPreparingProfileTitle), findsOneWidget);
  });
}
