import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:get_it/get_it.dart';

import 'package:payer_app/core/auth/payer_token_store.dart';
import 'package:payer_app/core/data/mock_payer_api_client.dart';
import 'package:payer_app/core/di/locator.dart';
import 'package:payer_app/features/jobs/presentation/agency_jobs_screen.dart';

/// P2 — the AGENCY My-jobs branch surfaces the #1202 reversible-pause controls:
/// an OPEN row offers Pause/Close, a PAUSED row offers a single Resume, and a
/// CLOSED row is terminal. The mock seed carries one of each so the whole
/// lifecycle is walkable + assertable here.
void main() {
  setUp(() async {
    await GetIt.instance.reset();
    setupLocator(
      apiClient: MockPayerApiClient(),
      secureStore: InMemoryKeyValueStore(),
    );
  });

  tearDown(() async => GetIt.instance.reset());

  Future<void> pump(WidgetTester tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(body: AgencyJobsView(onPost: () {})),
      ),
    );
    await tester.pumpAndSettle();
  }

  testWidgets('a PAUSED row shows Resume + a Paused pill (not Close)',
      (WidgetTester tester) async {
    await pump(tester);

    // The paused seed row.
    expect(find.text('Quality Inspector — Night shift'), findsOneWidget);
    expect(find.text('Paused'), findsOneWidget);
    // Its control is Resume.
    expect(find.text('Resume'), findsOneWidget);
  });

  testWidgets('an OPEN row shows Pause + Close', (WidgetTester tester) async {
    await pump(tester);

    expect(find.text('Open'), findsOneWidget);
    expect(find.text('Pause'), findsOneWidget);
    expect(find.text('Close'), findsOneWidget);
  });

  testWidgets('tapping Resume flips the paused row to open',
      (WidgetTester tester) async {
    await pump(tester);

    await tester.tap(find.text('Resume'));
    await tester.pump(); // run the async resume + refetch
    await tester.pumpAndSettle();

    // The row is now OPEN — a second Open pill appears and Resume is gone.
    expect(find.text('Open'), findsNWidgets(2));
    expect(find.text('Resume'), findsNothing);

    // Let the success toast auto-dismiss so it does not outlive the test.
    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();
  });
}
