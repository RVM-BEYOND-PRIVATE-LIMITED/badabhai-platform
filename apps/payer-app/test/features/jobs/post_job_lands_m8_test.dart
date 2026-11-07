import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:get_it/get_it.dart';

import 'package:payer_app/core/auth/payer_token_store.dart';
import 'package:payer_app/core/data/mock_payer_api_client.dart';
import 'package:payer_app/core/data/models.dart';
import 'package:payer_app/core/di/locator.dart';
import 'package:payer_app/core/session/app_session.dart';
import 'package:payer_app/core/session/app_session_cubit.dart';
import 'package:payer_app/features/jobs/presentation/post_job_screen.dart';

/// #2596 (M8) — a successful post hands the NEW posting's id to
/// `PostJobScreen.onPosted` (the shell lands on Jobs with that card
/// highlighted) instead of a bare `onBack`; without `onPosted` the old
/// hand-off is unchanged.
///
/// Matching V1 off, as in `post_job_screen_test.dart`, so the form can be
/// filled without a backend. A company form is served one of the 16 trades
/// (#2635 — a company job cannot be posted without one; #2718 — the agency
/// form's single picker lists it too).
class _LegacyFormApi extends MockPayerApiClient {
  _LegacyFormApi({required this.trades});

  final List<PostingTradeForm> trades;

  @override
  Future<List<MatchSkill>> fetchMatchSkills() async => const <MatchSkill>[];

  @override
  Future<List<PostingTradeForm>> fetchPostingTrades() async => trades;
}

const PostingTradeForm _welder = PostingTradeForm(
  roleKind: 'welder',
  roleLabel: 'Welder',
  packId: 'qp_welding_trade',
  matchSkillId: 'mskill_welder',
);

void main() {
  late List<String> posted;
  late int backs;

  Future<void> pump(
    WidgetTester tester,
    PayerRole role, {
    bool wireOnPosted = true,
  }) async {
    await GetIt.instance.reset();
    setupLocator(
      apiClient: _LegacyFormApi(
        trades: const <PostingTradeForm>[_welder],
      ),
      secureStore: InMemoryKeyValueStore(),
    );
    locator<AppSessionCubit>().signIn(role);
    posted = <String>[];
    backs = 0;

    // Tall viewport: every field is built, and 'Post job' is reachable.
    tester.view.physicalSize = const Size(1000, 4000);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: PostJobScreen(
            onBack: () => backs++,
            onPosted: wireOnPosted ? posted.add : null,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  Future<void> typeInto(WidgetTester tester, String label, String value) async {
    final Finder field = find.ancestor(
      of: find.text(label),
      matching: find.byType(Column),
    );
    await tester.enterText(
      find.descendant(of: field.first, matching: find.byType(TextField)),
      value,
    );
    await tester.pump();
  }

  Future<void> tapChip(WidgetTester tester, String label) async {
    await tester.tap(find.text(label).last);
    await tester.pumpAndSettle();
  }

  /// Pick the company job's trade from the 16-trade role picker (#2635).
  Future<void> pickTrade(WidgetTester tester) async {
    await tester.tap(find.text('— pick the role —'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Welder').last);
    await tester.pumpAndSettle();
  }

  Future<void> addChip(
    WidgetTester tester, {
    required String addLabel,
    required Key fieldKey,
    required String phrase,
  }) async {
    await tester.tap(find.text(addLabel));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(fieldKey), phrase);
    await tester.tap(find.text('Add'));
    await tester.pumpAndSettle();
  }

  /// Every fact the worker's card renders — the form refuses to post without.
  Future<void> fillCardContent(
    WidgetTester tester, {
    String neededBy = 'Immediately',
  }) async {
    await typeInto(tester, 'City', 'Pune');
    await typeInto(tester, 'Pay min ₹/mo', '18000');
    await typeInto(tester, 'Pay max ₹/mo', '24000');
    await typeInto(tester, 'Exp min (yrs)', '1');
    await typeInto(tester, 'Exp max (yrs)', '4');
    await typeInto(
        tester, 'Description', 'Turning job work on Fanuc controls.');
    await tapChip(tester, 'In-hand');
    await tapChip(tester, 'Night');
    await tapChip(tester, neededBy);
    await addChip(
      tester,
      addLabel: '+ Add benefit',
      fieldKey: const Key('add-benefit-field'),
      phrase: 'PF + ESI',
    );
    await addChip(
      tester,
      addLabel: '+ Add requirement',
      fieldKey: const Key('add-requirement-field'),
      phrase: 'Fanuc control',
    );
  }

  /// Never `pumpAndSettle` after a successful post: the button keeps its
  /// spinner (the screen hands off and stays submitting).
  Future<void> tapPost(WidgetTester tester) async {
    await tester.tap(find.text('Post job'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));
  }

  testWidgets('company: the created draft\'s id goes to onPosted, not onBack',
      (WidgetTester tester) async {
    await pump(tester, PayerRole.company);
    await typeInto(tester, 'Job title', 'CNC Operator');
    await pickTrade(tester);
    await fillCardContent(tester);

    await tapPost(tester);

    // MockPayerApiClient numbers its drafts from 101.
    expect(posted, <String>['mock-job-101']);
    expect(backs, 0);
    expect(find.text('Job posted'), findsOneWidget);
  });

  testWidgets('agency: the created posting\'s id goes to onPosted',
      (WidgetTester tester) async {
    await pump(tester, PayerRole.agency);
    await typeInto(tester, 'Job title', 'Lathe hand');
    await pickTrade(tester);
    await fillCardContent(tester, neededBy: 'Immediate');

    await tapPost(tester);

    expect(posted, hasLength(1));
    expect(posted.single, startsWith('mock-agency-'));
    expect(backs, 0);
  });

  testWidgets('without onPosted the old hand-off (onBack) is unchanged',
      (WidgetTester tester) async {
    await pump(tester, PayerRole.company, wireOnPosted: false);
    await typeInto(tester, 'Job title', 'CNC Operator');
    await pickTrade(tester);
    await fillCardContent(tester);

    await tapPost(tester);

    expect(backs, 1);
  });

  testWidgets('a refused post hands off nothing', (WidgetTester tester) async {
    await pump(tester, PayerRole.company);
    await tapPost(tester); // untouched form: refused before any call

    expect(posted, isEmpty);
    expect(backs, 0);
  });
}
