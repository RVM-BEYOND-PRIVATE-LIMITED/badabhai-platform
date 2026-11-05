import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:get_it/get_it.dart';

import 'package:payer_app/core/auth/payer_token_store.dart';
import 'package:payer_app/core/data/mock_payer_api_client.dart';
import 'package:payer_app/core/di/locator.dart';
import 'package:payer_app/core/session/app_session.dart';
import 'package:payer_app/core/session/app_session_cubit.dart';
import 'package:payer_app/core/session/network_status.dart';
import 'package:payer_app/features/shell/presentation/app_shell.dart';

/// #2690 (rule 3) — one slim offline banner at the top of the shell, hidden on
/// reconnect with a brief "Back online" toast. The test simulates the network
/// loss the way the HTTP layer reports it: the shared [NetworkStatus] flips.
void main() {
  const AppSession session = AppSession(
    role: PayerRole.company,
    account: PayerAccount(
      name: 'Kalyani Industries',
      plan: 'Starter',
      initials: 'KI',
    ),
  );

  setUp(() async {
    await GetIt.instance.reset();
    setupLocator(
      apiClient: MockPayerApiClient(),
      secureStore: InMemoryKeyValueStore(),
    );
  });

  tearDown(() async => GetIt.instance.reset());

  testWidgets('appears while offline, hides on reconnect and says so', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        home: BlocProvider<AppSessionCubit>.value(
          value: locator<AppSessionCubit>(),
          child: const AppShell(session: session),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text("You're offline. We'll retry when you're back."),
        findsNothing);

    locator<NetworkStatus>().markOffline();
    await tester.pump();
    expect(find.text("You're offline. We'll retry when you're back."),
        findsOneWidget);

    locator<NetworkStatus>().markOnline();
    await tester.pump(); // the banner leaves…
    await tester.pump(); // …and the post-frame toast is shown
    expect(find.text("You're offline. We'll retry when you're back."),
        findsNothing);
    expect(find.text('Back online'), findsOneWidget);

    // Let the toast's own timer finish so no timer outlives the test.
    await tester.pump(const Duration(seconds: 5));
    await tester.pumpAndSettle();
  });
}
