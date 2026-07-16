// WA-2: the job-detail CTA is gated on the worker's OWN application state.
//
// Opened from an Applied-jobs row, the detail receives the row's REAL recorded
// `action` (GET /workers/me/applications) via [JobDetail.applicationAction] —
// an already-applied job shows "Applied ✓" + the real status and NEVER an
// apply action. Opened from the feed (undecided, post-WA-1), the normal
// "Apply karein" CTA renders.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/core/widgets/bb_button.dart';
import 'package:badabhai_worker_app/features/swipe/domain/job_detail.dart';
import 'package:badabhai_worker_app/features/swipe/domain/swipe_repository.dart';
import 'package:badabhai_worker_app/features/swipe/presentation/job_detail_screen.dart';

class MockSwipeRepository extends Mock implements SwipeRepository {}

Future<void> _pump(WidgetTester tester, JobDetail detail) async {
  GoogleFonts.config.allowRuntimeFetching = false;
  await locator.reset();
  locator.registerLazySingleton<SwipeRepository>(() => MockSwipeRepository());

  tester.view.physicalSize = const Size(900, 1900);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);

  await tester.pumpWidget(MaterialApp(
    theme: AppTheme.light(),
    home: JobDetailScreen(detail: detail),
  ));
  await tester.pump();
}

void main() {
  tearDown(() async => locator.reset());

  testWidgets(
      'an ALREADY-APPLIED job shows the Hinglish applied status and never '
      'an apply action', (WidgetTester tester) async {
    await _pump(
      tester,
      const JobDetail(
        jobId: 'j1',
        title: 'CNC Operator',
        city: 'Pune',
        area: 'Pimpri',
        applicationAction: 'applied', // the REAL action from the applications API
      ),
    );

    // Gated on the real recorded action, rendered in the DS's warm Hinglish
    // (L-2) — the raw wire enum never reaches the UI.
    expect(find.text('Aapne apply kar diya ✓'), findsOneWidget);
    expect(find.textContaining('Status:'), findsNothing);
    // Never an apply action for an applied job — no CTA, no button at all.
    expect(find.text('Apply karein'), findsNothing);
    expect(find.byType(BbButton), findsNothing);
  });

  testWidgets('an undecided job (feed hand-over, no action) keeps the apply CTA',
      (WidgetTester tester) async {
    await _pump(
      tester,
      const JobDetail(jobId: 'j2', title: 'VMC Operator', city: 'Pune'),
    );

    expect(find.text('Apply karein'), findsOneWidget);
    expect(find.text('Aapne apply kar diya ✓'), findsNothing);
  });
}
