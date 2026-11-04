// The employer-sharing prompt, driven through the REAL cubit, repository and
// ApiClient over a fake HTTP client — so "no network call" is observed at the
// wire, not inferred from a mock that was never asked.
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/session/session_repository.dart';
import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/features/consent/data/consent_repository_impl.dart';
import 'package:badabhai_worker_app/features/consent/data/employer_sharing_prompt_store.dart';
import 'package:badabhai_worker_app/features/consent/domain/employer_sharing_prompt_gate.dart';
import 'package:badabhai_worker_app/features/consent/presentation/cubit/employer_sharing_prompt_cubit.dart';
import 'package:badabhai_worker_app/features/consent/presentation/employer_sharing_prompt_screen.dart';
import 'package:badabhai_worker_app/features/consent/presentation/widgets/employer_sharing_notice.dart';
import 'package:badabhai_worker_app/router.dart';

void main() {
  late List<http.Request> requests;
  late http.Response Function(http.Request) respond;
  late InMemoryEmployerSharingPromptStore store;

  http.Response granted(http.Request _) => http.Response(
        jsonEncode(<String, dynamic>{
          'ok': true,
          'consent_id': 'c2',
          'granted': <String>['employer_sharing', 'employer_messaging'],
        }),
        200,
      );

  setUp(() async {
    await locator.reset();
    requests = <http.Request>[];
    respond = granted;
    store = InMemoryEmployerSharingPromptStore();
    final ApiClient api = ApiClient(
      baseUrl: 'http://test',
      client: MockClient((http.Request req) async {
        requests.add(req);
        return respond(req);
      }),
    );
    final SessionRepository session = SessionRepository()
      ..setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: 'tok');
    final ConsentRepositoryImpl repo = ConsentRepositoryImpl(api, session);
    final EmployerSharingPromptGate gate = EmployerSharingPromptGate(
      repository: repo,
      store: store,
      isSignedIn: () => true,
      workerId: () => 'w1',
    );
    locator.registerFactory<EmployerSharingPromptCubit>(
      () => EmployerSharingPromptCubit(repo, gate),
    );
  });

  tearDown(() => locator.reset());

  /// '/' pushes the prompt the way the shell and Settings do, and prints what
  /// it popped with.
  Future<void> pump(WidgetTester tester) async {
    final GoRouter router = GoRouter(
      initialLocation: '/',
      routes: <RouteBase>[
        GoRoute(
          path: '/',
          builder: (_, __) => const _Caller(),
        ),
        GoRoute(
          path: Routes.employerSharing,
          builder: (_, __) => const EmployerSharingPromptScreen(),
        ),
      ],
    );
    await tester.pumpWidget(
      MaterialApp.router(theme: AppTheme.light(), routerConfig: router),
    );
    await tester.tap(find.text('OPEN'));
    await tester.pumpAndSettle();
    expect(find.byType(EmployerSharingNotice), findsOneWidget);
  }

  Future<void> tapButton(WidgetTester tester, String label) async {
    await tester.ensureVisible(find.text(label));
    await tester.tap(find.text(label));
    await tester.pumpAndSettle();
  }

  testWidgets('shows the notice with both buttons', (WidgetTester tester) async {
    await pump(tester);
    expect(find.text(EmployerSharingNotice.heading), findsOneWidget);
    expect(find.text('Haan, dikhayein'), findsOneWidget);
    expect(find.text('Abhi nahi'), findsOneWidget);
    expect(requests, isEmpty, reason: 'opening the prompt writes nothing');
  });

  testWidgets("'Haan' POSTs the grant with the notice version and pops true", (
    WidgetTester tester,
  ) async {
    await pump(tester);
    await tapButton(tester, 'Haan, dikhayein');

    expect(requests, hasLength(1));
    expect(requests.single.method, 'POST');
    expect(requests.single.url.path, '/consent/employer-contact/grant');
    expect(jsonDecode(requests.single.body),
        <String, dynamic>{'consent_version': kConsentVersion});
    expect(find.byType(EmployerSharingNotice), findsNothing);
    expect(find.text('RESULT true'), findsOneWidget);
  });

  testWidgets('a failed grant stays open, says why, and can be retried', (
    WidgetTester tester,
  ) async {
    respond = (_) => http.Response('{"message":"no live consent"}', 404);
    await pump(tester);
    await tapButton(tester, 'Haan, dikhayein');

    expect(find.byType(EmployerSharingNotice), findsOneWidget,
        reason: 'a failure must not close the prompt');
    expect(find.textContaining('404'), findsOneWidget);
    expect(find.text('RESULT true'), findsNothing);
    expect(
      await store.isDismissed(version: kConsentVersion, workerId: 'w1'),
      isFalse,
    );

    // Buttons stay usable: a retry that succeeds closes it.
    respond = granted;
    await tapButton(tester, 'Haan, dikhayein');
    expect(requests, hasLength(2));
    expect(find.text('RESULT true'), findsOneWidget);
  });

  testWidgets("'Abhi nahi' remembers the answer, calls nothing, pops false", (
    WidgetTester tester,
  ) async {
    await pump(tester);
    await tapButton(tester, 'Abhi nahi');

    expect(requests, isEmpty, reason: "'Abhi nahi' makes no network call");
    expect(
      await store.isDismissed(version: kConsentVersion, workerId: 'w1'),
      isTrue,
    );
    expect(find.byType(EmployerSharingNotice), findsNothing);
    expect(find.text('RESULT false'), findsOneWidget);
  });

  testWidgets('system back is a "not now" — never a grant', (
    WidgetTester tester,
  ) async {
    await pump(tester);
    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();

    expect(requests, isEmpty);
    expect(
      await store.isDismissed(version: kConsentVersion, workerId: 'w1'),
      isTrue,
    );
    expect(find.text('RESULT false'), findsOneWidget);
  });
}

class _Caller extends StatefulWidget {
  const _Caller();

  @override
  State<_Caller> createState() => _CallerState();
}

class _CallerState extends State<_Caller> {
  String _result = 'none';

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Column(
        children: <Widget>[
          TextButton(
            onPressed: () async {
              final bool? r =
                  await context.push<bool>(Routes.employerSharing);
              if (mounted) setState(() => _result = '$r');
            },
            child: const Text('OPEN'),
          ),
          Text('RESULT $_result'),
        ],
      ),
    );
  }
}
