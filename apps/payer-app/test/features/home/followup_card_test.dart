import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:get_it/get_it.dart';

import 'package:payer_app/core/auth/payer_token_store.dart';
import 'package:payer_app/core/data/mock_payer_api_client.dart';
import 'package:payer_app/core/data/models.dart';
import 'package:payer_app/core/data/unlock_followup_models.dart';
import 'package:payer_app/core/di/locator.dart';
import 'package:payer_app/core/session/app_session.dart';
import 'package:payer_app/features/home/presentation/home_screen.dart';
import 'package:payer_app/features/home/presentation/widgets/followup_section.dart';

class _FollowupApi extends MockPayerApiClient {
  List<UnlockFollowupItem> items = <UnlockFollowupItem>[
    const UnlockFollowupItem(
      unlockId: 'u-1',
      workerId: 'w-1',
      grantedAt: '2026-11-01T10:00:00Z',
    ),
    const UnlockFollowupItem(
      unlockId: 'u-2',
      workerId: 'w-2',
      grantedAt: '2026-11-02T10:00:00Z',
      outcome: UnlockFollowupOutcome.stillTalking,
    ),
  ];
  bool off = false;
  int? errorStatus;
  final List<String> answered = <String>[];

  @override
  Future<UnlockFollowupPage?> fetchDueUnlockOutcomes({
    int limit = 20,
    String? cursor,
  }) async {
    if (off) throw const PayerApiException(404);
    if (errorStatus != null) throw PayerApiException(errorStatus!);
    return UnlockFollowupPage(
      items: List<UnlockFollowupItem>.unmodifiable(items),
      nextCursor: null,
    );
  }

  @override
  Future<UnlockFollowupResult> recordUnlockOutcome({
    required String unlockId,
    required UnlockFollowupOutcome outcome,
    required String idempotencyKey,
  }) async {
    answered.add(unlockId);
    final int index =
        items.indexWhere((UnlockFollowupItem r) => r.unlockId == unlockId);
    if (index < 0) throw const PayerApiException(404);
    final UnlockFollowupItem row = items.removeAt(index);
    return UnlockFollowupResult(
      unlockId: row.unlockId,
      workerId: row.workerId,
      outcome: outcome,
      previousOutcome: UnlockStoredOutcome.fromCompany(row.outcome),
      answeredAt: '2026-11-20T10:00:00Z',
      changed: true,
    );
  }
}

const AppSession _session = AppSession(
  role: PayerRole.company,
  account: PayerAccount(
    name: 'Kalyani Industries',
    plan: 'Starter',
    initials: 'KI',
  ),
);

void main() {
  late _FollowupApi api;

  setUp(() async {
    await GetIt.instance.reset();
    api = _FollowupApi();
    setupLocator(apiClient: api, secureStore: InMemoryKeyValueStore());
  });

  Future<void> pumpHome(WidgetTester tester) async {
    tester.view.physicalSize = const Size(360, 640);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: HomeScreen(
            session: _session,
            onPost: () {},
            onBrowse: () {},
            onOpenCredits: () {},
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  testWidgets('due rows show a faceless FOLLOW-UP card', (tester) async {
    await pumpHome(tester);

    expect(find.byKey(kFollowupCardKey), findsOneWidget);
    expect(find.text('FOLLOW-UP'), findsOneWidget);
    expect(find.text('Did you hire this person?'), findsOneWidget);
    expect(find.text('Unlocked contact'), findsNWidgets(2));
    expect(find.textContaining('Unlocked 1 Nov'), findsOneWidget);
    // Faceless: no name/phone from the mock candidate pool leaks in.
    expect(find.text('Ramesh Kumar'), findsNothing);
    expect(find.textContaining('+91'), findsNothing);
  });

  testWidgets('404 hides the card silently, including no error copy',
      (tester) async {
    api.off = true;

    await pumpHome(tester);

    expect(find.byKey(kFollowupCardKey), findsNothing);
    expect(find.text('FOLLOW-UP'), findsNothing);
    expect(find.text('Could not load'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('503 shows a retry, and the retry brings the rows back',
      (tester) async {
    api.errorStatus = 503;

    await pumpHome(tester);

    expect(find.byKey(kFollowupRetryCardKey), findsOneWidget);
    expect(find.byKey(kFollowupCardKey), findsNothing);

    api.errorStatus = null;
    await tester.tap(find.byKey(kFollowupRetryKey));
    await tester.pumpAndSettle();

    expect(find.byKey(kFollowupRetryCardKey), findsNothing);
    expect(find.byKey(kFollowupCardKey), findsOneWidget);
    expect(find.text('Unlocked contact'), findsNWidgets(2));
  });

  testWidgets('answering a row removes it from the card', (tester) async {
    await pumpHome(tester);
    final Finder answer = find.byKey(
      followupAnswerKey('u-1', UnlockFollowupOutcome.hired),
    );

    await tester.ensureVisible(answer);
    await tester.pumpAndSettle();
    await tester.tap(answer, warnIfMissed: false);
    await tester.pumpAndSettle();

    expect(api.answered, <String>['u-1']);
    expect(find.byKey(followupRowKey('u-1')), findsNothing);
    expect(find.byKey(followupRowKey('u-2')), findsOneWidget);
    expect(find.text('Unlocked contact'), findsOneWidget);
  });
}
