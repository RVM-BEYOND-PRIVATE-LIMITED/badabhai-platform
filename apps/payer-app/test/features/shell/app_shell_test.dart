import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:get_it/get_it.dart';

import 'package:payer_app/core/auth/payer_token_store.dart';
import 'package:payer_app/core/data/mock_payer_api_client.dart';
import 'package:payer_app/core/data/models.dart';
import 'package:payer_app/core/di/locator.dart';
import 'package:payer_app/core/session/app_session.dart';
import 'package:payer_app/core/session/app_session_cubit.dart';
import 'package:payer_app/core/widgets/bb_bottom_nav.dart';
import 'package:payer_app/features/find/presentation/find_screen.dart';
import 'package:payer_app/features/home/presentation/home_screen.dart';
import 'package:payer_app/features/jobs/presentation/post_job_screen.dart';
import 'package:payer_app/features/shell/presentation/app_shell.dart';

/// AppShell navigation contract.
///
/// #359 — the shell's tab + Post/Credits/Reveal overlays are setState state on a
/// single Navigator route, so the Android system back used to finish the
/// activity from anywhere in the shell (losing a half-filled Post-a-job form).
/// Back must unwind the IN-SHELL stack first and only exit from a bare Home.
///
/// #382 — the branches must be kept mounted across tab switches (IndexedStack),
/// so a hop away and back no longer disposes the tab's cubit, refetches, and
/// resets its selection/scroll — while an unvisited tab must still cost nothing.
void main() {
  late _CountingPayerApi api;
  late List<MethodCall> platformCalls;

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
    api = _CountingPayerApi();
    setupLocator(apiClient: api, secureStore: InMemoryKeyValueStore());

    // SystemNavigator.pop() — i.e. "the app just exited" — rides
    // SystemChannels.platform, so capturing that channel is how a widget test
    // can tell an intercepted back from one that closed the activity.
    platformCalls = <MethodCall>[];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform,
            (MethodCall call) async {
      platformCalls.add(call);
      return null;
    });
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, null);
  });

  Future<void> pumpShell(WidgetTester tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: BlocProvider<AppSessionCubit>.value(
          value: locator<AppSessionCubit>(),
          child: const AppShell(session: session),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  /// Presses the Android system back exactly as the engine does (the
  /// `flutter/navigation` `popRoute` message) and reports whether the app would
  /// have exited.
  Future<bool> systemBack(WidgetTester tester) async {
    platformCalls.clear();
    await tester.binding.defaultBinaryMessenger.handlePlatformMessage(
      'flutter/navigation',
      const JSONMethodCodec().encodeMethodCall(const MethodCall('popRoute')),
      (ByteData? _) {},
    );
    await tester.pumpAndSettle();
    return platformCalls
        .any((MethodCall call) => call.method == 'SystemNavigator.pop');
  }

  /// Taps a bottom-nav destination by label. Scoped to [BbBottomNav] because a
  /// mounted-but-hidden tab can carry the same word in its own body.
  Future<void> tapNav(WidgetTester tester, String label) async {
    await tester.tap(find.descendant(
      of: find.byType(BbBottomNav),
      matching: find.text(label),
    ));
    await tester.pumpAndSettle();
  }

  String navId(WidgetTester tester) =>
      tester.widget<BbBottomNav>(find.byType(BbBottomNav)).currentId;

  group('#359 — Android system back inside the shell', () {
    testWidgets('dismisses the Post overlay instead of exiting the app',
        (WidgetTester tester) async {
      await pumpShell(tester);
      await tester.tap(find.descendant(
        of: find.byType(HomeScreen),
        matching: find.text('Post a job'),
      ));
      await tester.pumpAndSettle();
      expect(find.byType(PostJobScreen), findsOneWidget);

      final bool exited = await systemBack(tester);

      // The overlay is gone and the activity survived — the form is no longer
      // thrown away by the primary Android affordance. `skipOffstage: false`
      // because IndexedStack reports its hidden branches as offstage: this must
      // assert the overlay is really GONE, not merely hidden.
      expect(exited, isFalse);
      expect(find.byType(PostJobScreen, skipOffstage: false), findsNothing);
      expect(navId(tester), 'home');
    });

    testWidgets('returns a non-home tab to Home instead of exiting the app',
        (WidgetTester tester) async {
      await pumpShell(tester);
      await tapNav(tester, 'Jobs');
      expect(navId(tester), 'jobs');

      final bool exited = await systemBack(tester);

      expect(exited, isFalse);
      expect(navId(tester), 'home');
    });

    testWidgets('still exits from a bare Home — that is the shell root',
        (WidgetTester tester) async {
      await pumpShell(tester);

      // Nothing left to unwind: back bubbles out, which is what a payer expects
      // at the root. Guards against a PopScope that traps the user in the app.
      expect(await systemBack(tester), isTrue);
    });
  });

  group('#382 — tab branches survive a switch', () {
    testWidgets('an unvisited tab loads nothing on cold start',
        (WidgetTester tester) async {
      await pumpShell(tester);

      // The IndexedStack must be LAZY: mounting all five branches eagerly would
      // fire every tab's load() before the payer opens any of them.
      expect(api.candidateLoads, 0);
      expect(find.byType(FindScreen, skipOffstage: false), findsNothing);
    });

    testWidgets('leaving Find and returning does not rebuild/refetch its cubit',
        (WidgetTester tester) async {
      await pumpShell(tester);

      await tapNav(tester, 'Find');
      expect(api.candidateLoads, 1);

      await tapNav(tester, 'Credits');
      // The branch is hidden (offstage to a finder), not destroyed — that is
      // what preserves the loaded feed, the selected job and the scroll offset.
      // It stays offstage to a DEFAULT finder, so a hidden tab never leaks its
      // text into another tab's assertions.
      expect(find.byType(FindScreen, skipOffstage: false), findsOneWidget);
      expect(find.byType(FindScreen), findsNothing);

      await tapNav(tester, 'Find');
      // Before the fix this was a second load: fresh FindCubit, spinner,
      // selection reset to the first open job, scroll lost.
      expect(api.candidateLoads, 1);
    });

    testWidgets('an overlay round-trip does not tear the tabs down',
        (WidgetTester tester) async {
      await pumpShell(tester);
      await tapNav(tester, 'Find');
      expect(api.candidateLoads, 1);

      await tapNav(tester, 'Home');
      await tester.tap(find.descendant(
        of: find.byType(HomeScreen),
        matching: find.text('Post a job'),
      ));
      await tester.pumpAndSettle();
      expect(find.byType(PostJobScreen), findsOneWidget);

      await systemBack(tester);
      await tapNav(tester, 'Find');

      expect(api.candidateLoads, 1);
    });

    testWidgets('the Post overlay itself opens fresh every time',
        (WidgetTester tester) async {
      await pumpShell(tester);

      Future<void> openPost() async {
        await tester.tap(find.descendant(
          of: find.byType(HomeScreen),
          matching: find.text('Post a job'),
        ));
        await tester.pumpAndSettle();
      }

      await openPost();
      final PostJobScreen first = tester.widget<PostJobScreen>(
        find.byType(PostJobScreen),
      );
      await systemBack(tester);
      await openPost();

      // Deliberate asymmetry with the tabs: a dismissed Post must NOT come back
      // holding the previous draft's 11 controllers of input.
      expect(
        identical(first, tester.widget<PostJobScreen>(find.byType(PostJobScreen))),
        isFalse,
      );
    });
  });
}

/// Counts the call [FindCubit.load] makes in the mock seam, so a test can prove
/// the tab's cubit was NOT recreated on a tab switch (#382).
class _CountingPayerApi extends MockPayerApiClient {
  int candidateLoads = 0;

  @override
  Future<List<Candidate>> fetchCandidates() {
    candidateLoads++;
    return super.fetchCandidates();
  }
}
