import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:get_it/get_it.dart';

import 'package:payer_app/core/auth/payer_token_store.dart';
import 'package:payer_app/core/data/mock_payer_api_client.dart';
import 'package:payer_app/core/di/locator.dart';
import 'package:payer_app/features/jobs/presentation/agency_jobs_screen.dart';

/// The AGENCY My-jobs branch offers Close ONLY — never Pause or Resume. On the
/// deployed backend `POST /payer/agency/jobs/:id/pause` maps to a TERMINAL close
/// ("pause == close"), so a Pause/Resume control would lie about server state
/// (issue #1202 tracks a real paused state + resume). A `paused` row still
/// renders a read-only pill but only offers Close. The mock seed carries one
/// open, one paused and one closed row so the whole card is assertable here.
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

  testWidgets('no Pause and no Resume control anywhere on the agency card',
      (WidgetTester tester) async {
    await pump(tester);

    expect(find.text('Pause'), findsNothing);
    expect(find.text('Resume'), findsNothing);
  });

  testWidgets('every non-closed row offers Close (open + paused), closed is '
      'terminal', (WidgetTester tester) async {
    await pump(tester);

    // Open + paused rows each carry a Close button; the closed row does not.
    expect(find.text('Close'), findsNWidgets(2));
    expect(find.text('This job is closed.'), findsOneWidget);
  });

  testWidgets('a PAUSED row keeps a read-only Paused pill but only offers Close',
      (WidgetTester tester) async {
    await pump(tester);

    // The paused seed row renders honestly (read-only pill), not mis-rendered.
    expect(find.text('Quality Inspector — Night shift'), findsOneWidget);
    expect(find.text('Paused'), findsOneWidget);
    // Both other pills still show — the model's paused awareness is intact.
    expect(find.text('Open'), findsOneWidget);
    expect(find.text('Closed'), findsOneWidget);
    // ...but no Resume control on that paused row.
    expect(find.text('Resume'), findsNothing);
  });

  testWidgets('tapping Close on the open row closes it (no reversible pause)',
      (WidgetTester tester) async {
    await pump(tester);

    // Close the OPEN row (first Close button).
    await tester.tap(find.text('Close').first);
    await tester.pump(); // run the async close + refetch
    await tester.pumpAndSettle();

    // The open row is now closed — the 'Open' pill is gone, a second 'Closed'
    // pill appears, and only the paused row still offers Close.
    expect(find.text('Open'), findsNothing);
    expect(find.text('Closed'), findsNWidgets(2));
    expect(find.text('Close'), findsOneWidget);
    // Still no Pause/Resume introduced by the transition.
    expect(find.text('Pause'), findsNothing);
    expect(find.text('Resume'), findsNothing);

    // Let the success toast auto-dismiss so it does not outlive the test.
    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();
  });
}
