import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:get_it/get_it.dart';

import 'package:payer_app/core/auth/payer_token_store.dart';
import 'package:payer_app/core/data/candidate_search_models.dart';
import 'package:payer_app/core/data/mock_payer_api_client.dart';
import 'package:payer_app/core/data/models.dart';
import 'package:payer_app/core/di/locator.dart';
import 'package:payer_app/core/session/app_session.dart';
import 'package:payer_app/core/session/app_session_cubit.dart';
import 'package:payer_app/core/widgets/bb_bottom_nav.dart';
import 'package:payer_app/features/find/presentation/find_screen.dart';
import 'package:payer_app/features/home/presentation/home_screen.dart';
import 'package:payer_app/features/job_posting_chat/presentation/job_posting_chat_screen.dart';
import 'package:payer_app/features/jobs/presentation/jobs_screen.dart';
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

  /// [systemBack] without settling — for asserting a transition mid-flight.
  Future<void> systemBackNoSettle(WidgetTester tester) async {
    await tester.binding.defaultBinaryMessenger.handlePlatformMessage(
      'flutter/navigation',
      const JSONMethodCodec().encodeMethodCall(const MethodCall('popRoute')),
      (ByteData? _) {},
    );
    await tester.pump();
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

    testWidgets('returning to a tab refetches its data (latest-on-switch)',
        (WidgetTester tester) async {
      await pumpShell(tester);

      await tapNav(tester, 'Find');
      expect(api.candidateLoads, 1);

      await tapNav(tester, 'Credits');
      // The branch stays mounted while hidden, but it is rebuilt with a fresh
      // cubit — and therefore a fresh API read — when its tab is selected again.
      expect(find.byType(FindScreen, skipOffstage: false), findsOneWidget);
      expect(find.byType(FindScreen), findsNothing);

      await tapNav(tester, 'Find');
      expect(api.candidateLoads, 2);
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
      // The overlay did not tear the hidden Find branch down…
      expect(find.byType(FindScreen, skipOffstage: false), findsOneWidget);
      expect(api.candidateLoads, 1);

      // …and selecting the tab again performs the refresh.
      await tapNav(tester, 'Find');
      expect(api.candidateLoads, 2);
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
        identical(
            first, tester.widget<PostJobScreen>(find.byType(PostJobScreen))),
        isFalse,
      );
    });
  });

  group('#2591 — in-shell overlays animate in and out', () {
    testWidgets('Post fades + slides over Home, then back out',
        (WidgetTester tester) async {
      await pumpShell(tester);
      await tester.tap(find.descendant(
        of: find.byType(HomeScreen),
        matching: find.text('Post a job'),
      ));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));
      // Mid-transition both are on stage: the overlay no longer hard-cuts.
      expect(find.byType(PostJobScreen), findsOneWidget);
      expect(find.byType(HomeScreen), findsOneWidget);

      await tester.pumpAndSettle();
      // Fully open: Home stays mounted but offstage (its state survives).
      expect(find.byType(HomeScreen), findsNothing);
      expect(find.byType(HomeScreen, skipOffstage: false), findsOneWidget);

      await systemBackNoSettle(tester);
      await tester.pump(const Duration(milliseconds: 100));
      // Mid-exit: Post is still painted while Home is back on stage.
      expect(find.byType(PostJobScreen), findsOneWidget);
      expect(find.byType(HomeScreen), findsOneWidget);

      await tester.pumpAndSettle();
      expect(find.byType(PostJobScreen, skipOffstage: false), findsNothing);
    });
  });

  // #2595 (M7) — the bottom nav steps aside under Post (one pinned bar, not
  // two), and leaving an overlay that holds unsaved input — by the system
  // Back or a nav tap — asks first.
  group('#2595 — full-screen tasks and the unsaved-changes guard', () {
    Future<void> openPost(WidgetTester tester) async {
      await tester.tap(find.descendant(
        of: find.byType(HomeScreen),
        matching: find.text('Post a job'),
      ));
      await tester.pumpAndSettle();
      expect(find.byType(PostJobScreen), findsOneWidget);
    }

    Future<void> openAiChat(WidgetTester tester) async {
      await tapNav(tester, 'Jobs');
      await tester.tap(find.descendant(
        of: find.byType(JobsScreen),
        matching: find.text(kAiPostLabel),
      ));
      await tester.pumpAndSettle();
      expect(find.byType(JobPostingChatScreen), findsOneWidget);
    }

    /// Types into the Post form's Job title box.
    Future<void> typeTitle(WidgetTester tester, String value) async {
      final Finder field = find.ancestor(
        of: find.text('Job title'),
        matching: find.byType(Column),
      );
      await tester.enterText(
        find.descendant(of: field.first, matching: find.byType(TextField)),
        value,
      );
      await tester.pump();
    }

    testWidgets('the bottom nav hides under Post and comes back after it', (
      WidgetTester tester,
    ) async {
      await pumpShell(tester);
      expect(find.byType(BbBottomNav), findsOneWidget);

      await openPost(tester);
      // Post brings its own pinned action bar — the nav no longer stacks
      // under it.
      expect(find.byType(BbBottomNav), findsNothing);
      expect(find.text('Post job'), findsOneWidget);

      await systemBack(tester);
      expect(find.byType(BbBottomNav), findsOneWidget);
      expect(navId(tester), 'home');
    });

    testWidgets('system Back on an untouched Post leaves without asking', (
      WidgetTester tester,
    ) async {
      await pumpShell(tester);
      await openPost(tester);
      final bool exited = await systemBack(tester);
      expect(exited, isFalse);
      expect(find.text('Discard this job?'), findsNothing);
      expect(find.byType(PostJobScreen, skipOffstage: false), findsNothing);
    });

    testWidgets('system Back on a filled-in Post asks before discarding it', (
      WidgetTester tester,
    ) async {
      await pumpShell(tester);
      await openPost(tester);
      await typeTitle(tester, 'CNC Setter');

      expect(await systemBack(tester), isFalse);
      expect(find.text('Discard this job?'), findsOneWidget);
      await tester.tap(find.text('Keep editing'));
      await tester.pumpAndSettle();
      // Still on the form, with what was typed.
      expect(find.byType(PostJobScreen), findsOneWidget);
      expect(find.widgetWithText(TextField, 'CNC Setter'), findsOneWidget);

      expect(await systemBack(tester), isFalse);
      await tester.tap(find.text('Discard'));
      await tester.pumpAndSettle();
      expect(find.byType(PostJobScreen, skipOffstage: false), findsNothing);
      expect(navId(tester), 'home');
    });

    testWidgets('a nav tap on the AI chat with an unsent message asks first', (
      WidgetTester tester,
    ) async {
      await pumpShell(tester);
      await openAiChat(tester);
      // The AI chat keeps the nav — a tap on it is the leave to guard.
      expect(find.byType(BbBottomNav), findsOneWidget);

      await tester.enterText(
        find.descendant(
          of: find.byType(JobPostingChatScreen),
          matching: find.byType(TextField),
        ),
        'CNC operators for the night shift',
      );
      await tester.pump();

      await tapNav(tester, 'Home');
      expect(find.text('Leave this chat?'), findsOneWidget);
      await tester.tap(find.text('Keep chatting'));
      await tester.pumpAndSettle();
      expect(find.byType(JobPostingChatScreen), findsOneWidget);

      await tapNav(tester, 'Home');
      await tester.tap(find.text('Leave'));
      await tester.pumpAndSettle();
      expect(find.byType(JobPostingChatScreen, skipOffstage: false),
          findsNothing);
      expect(navId(tester), 'home');
    });

    testWidgets('a nav tap on a chat with nothing unsent leaves at once', (
      WidgetTester tester,
    ) async {
      await pumpShell(tester);
      await openAiChat(tester);
      await tapNav(tester, 'Home');
      expect(find.text('Leave this chat?'), findsNothing);
      expect(find.byType(JobPostingChatScreen, skipOffstage: false),
          findsNothing);
      expect(navId(tester), 'home');
    });

    testWidgets('system Back on the chat with an unsent message asks first', (
      WidgetTester tester,
    ) async {
      await pumpShell(tester);
      await openAiChat(tester);
      await tester.enterText(
        find.descendant(
          of: find.byType(JobPostingChatScreen),
          matching: find.byType(TextField),
        ),
        'Two welders',
      );
      await tester.pump();

      expect(await systemBack(tester), isFalse);
      expect(find.text('Leave this chat?'), findsOneWidget);
      await tester.tap(find.text('Leave'));
      await tester.pumpAndSettle();
      expect(find.byType(JobPostingChatScreen, skipOffstage: false),
          findsNothing);
      expect(navId(tester), 'jobs');
    });
  });
}

/// Counts the Find tab's load in the mock seam, so a test can prove the tab's
/// cubit was NOT recreated on a tab switch (#382). Find opens on All candidates
/// (2026-11-03 rulings), whose load is the search's first page; the Applicants
/// view's mock list is counted too, should a test open it.
class _CountingPayerApi extends MockPayerApiClient {
  int candidateLoads = 0;

  @override
  Future<List<Candidate>> fetchCandidates() {
    candidateLoads++;
    return super.fetchCandidates();
  }

  @override
  Future<CandidateSearchPage> searchCandidates(CandidateSearchQuery query) {
    candidateLoads++;
    return super.searchCandidates(query);
  }
}
