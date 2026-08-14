// #844 — the profile CONFIRM screen ("Yeh sahi hai?") must NOT render the
// "Profile strength" row. A completeness score is not an input to "is this
// information correct?", and a low number (the 4/9 that prompted this) reads
// like a failing grade at the moment we want a simple yes. The strength card
// still lives on the Profile TAB (profile_tab_screen_test.dart) and `strength*`
// stay on ProfileSummary — this lock is only about the confirm step.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/features/profile/domain/profile_repository.dart';
import 'package:badabhai_worker_app/features/profile/presentation/cubit/profile_cubit.dart';
import 'package:badabhai_worker_app/features/profile/presentation/profile_preview_screen.dart';
import 'package:badabhai_worker_app/features/profile_tab/domain/profile_summary.dart';
import 'package:badabhai_worker_app/features/profile_tab/domain/profile_summary_repository.dart';

class MockProfileRepository extends Mock implements ProfileRepository {}

class MockProfileSummaryRepository extends Mock
    implements ProfileSummaryRepository {}

Future<void> _pump(WidgetTester tester, ProfileSummary summary) async {
  GoogleFonts.config.allowRuntimeFetching = false;
  await locator.reset();
  final MockProfileRepository repo = MockProfileRepository();
  final MockProfileSummaryRepository summaryRepo = MockProfileSummaryRepository();
  when(() => repo.extractProfile()).thenAnswer((_) async => 'p1');
  when(() => summaryRepo.summary()).thenAnswer((_) async => summary);
  locator.registerFactory<ProfileCubit>(() => ProfileCubit(repo, summaryRepo));

  tester.view.physicalSize = const Size(900, 1900);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);

  await tester.pumpWidget(
    MaterialApp(theme: AppTheme.light(), home: const ProfilePreviewScreen()),
  );
  await tester.pump(); // extracting
  await tester.pump(); // extractProfile future resolves
  await tester.pump(); // summary future resolves → ready
}

void main() {
  tearDown(() async => locator.reset());

  testWidgets(
    'the confirm screen shows Trade / City and the confirm actions, and NO '
    'Profile strength row (#844)',
    (WidgetTester tester) async {
      // The 4/9 shape from the screenshot that prompted the removal.
      await _pump(
        tester,
        const ProfileSummary(
          tradeLabel: 'Welder',
          city: 'Pune',
          strengthSignals: 4,
          strengthMax: 9,
        ),
      );

      // The confirm step itself renders.
      expect(find.text('Yeh sahi hai?'), findsOneWidget);
      expect(find.text('Haan, sahi hai'), findsOneWidget);
      expect(find.text('Badlo'), findsOneWidget);

      // The data rows the worker confirms stay.
      expect(find.text('Trade'), findsOneWidget);
      expect(find.text('Welder'), findsOneWidget);
      expect(find.text('City'), findsOneWidget);
      expect(find.text('Pune'), findsOneWidget);

      // The strength row is gone — no label, no "N/max cheezein complete", no
      // bare "4/9" grade.
      expect(find.text('Profile strength'), findsNothing);
      expect(find.textContaining('cheezein complete'), findsNothing);
      expect(find.textContaining('4/9'), findsNothing);
    },
  );
}
