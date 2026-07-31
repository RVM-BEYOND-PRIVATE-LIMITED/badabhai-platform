import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:get_it/get_it.dart';

import 'package:payer_app/core/auth/payer_token_store.dart';
import 'package:payer_app/core/data/job_posting_chat_models.dart';
import 'package:payer_app/core/data/mock_payer_api_client.dart';
import 'package:payer_app/core/data/models.dart';
import 'package:payer_app/core/di/locator.dart';
import 'package:payer_app/core/session/app_session.dart';
import 'package:payer_app/core/session/app_session_cubit.dart';
import 'package:payer_app/features/jobs/presentation/jobs_screen.dart';

/// STORE POLICY (owner decision, ADR-0035 slice) + the ADDITIVE AI create path.
///
/// My-jobs used to expose a one-tap "Plan & boost" sheet — Buy plan · Standard /
/// Pro, Boost reach, Top up quota — each charging real money through
/// `POST /payer/job-postings/:id/{plan,boost,quota-topup}` behind a confirm
/// dialog. Selling a digital entitlement from inside a store-distributed app is
/// exactly what App Store / Play Store IAP policy governs, so the app now has
/// ZERO money-spending actions and links out to the web portal instead.
///
/// These tests fail against the old screen: the money labels are all present on
/// an open posting, and there is no external affordance.
class _JobsApi extends MockPayerApiClient {
  _JobsApi({this.sessions = const <JobPostingChatSessionSummary>[]});

  final List<JobPostingChatSessionSummary> sessions;

  @override
  Future<List<JobPosting>> fetchJobs({String? status}) async => <JobPosting>[
        const JobPosting(
          id: 'job-1',
          title: 'CNC Setter',
          band: '2-5',
          locationLabel: 'Chakan, Pune',
          createdAt: '2026-07-20T00:00:00Z',
          wireStatus: 'open',
          status: JobStatus.live,
          filled: 0,
          quota: 0,
          applicants: 0,
          unlocks: 0,
          verified: false,
          boosted: false,
        ),
      ];

  @override
  Future<List<JobPostingChatSessionSummary>>
      fetchJobPostingChatSessions() async => sessions;
}

void main() {
  late _JobsApi api;
  final List<Uri> launched = <Uri>[];
  final List<String?> aiOpens = <String?>[];

  Future<void> pump(
    WidgetTester tester, {
    List<JobPostingChatSessionSummary> sessions =
        const <JobPostingChatSessionSummary>[],
    bool wireAi = true,
  }) async {
    await GetIt.instance.reset();
    launched.clear();
    aiOpens.clear();
    api = _JobsApi(sessions: sessions);
    setupLocator(apiClient: api, secureStore: InMemoryKeyValueStore());
    locator<AppSessionCubit>().signIn(PayerRole.company);

    // Capture WHERE an external link goes without a platform channel
    // (`launchUrl` throws MissingPluginException under `flutter test`).
    jobsExternalUrlLauncher = (Uri url) async {
      launched.add(url);
      return true;
    };
    addTearDown(() => jobsExternalUrlLauncher = defaultExternalUrlLauncher);

    tester.view.physicalSize = const Size(1000, 2400);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: JobsScreen(
            onPost: () {},
            onAiPost: wireAi ? (String? id) => aiOpens.add(id) : null,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  group('no money-spending action exists in the app', () {
    testWidgets('an OPEN posting shows no buy/boost/top-up affordance',
        (WidgetTester tester) async {
      await pump(tester);

      for (final String gone in <String>[
        'Plan & boost',
        'Buy plan · Standard',
        'Buy plan · Pro',
        'Boost reach',
        'Top up quota · +10 views',
        'Top up quota · +30 views',
        'Boost',
      ]) {
        expect(find.text(gone), findsNothing, reason: gone);
      }
    });

    testWidgets('it offers the external "manage on web" path instead, and says '
        'out loud why', (WidgetTester tester) async {
      await pump(tester);

      expect(find.text(kManagePlanOnWebLabel), findsOneWidget);
      expect(find.text(kManagePlanOnWebNote), findsOneWidget);
    });

    testWidgets('tapping it hands an https web URL to the OS, not an in-app '
        'purchase', (WidgetTester tester) async {
      await pump(tester);

      await tester.tap(find.text(kManagePlanOnWebLabel));
      await tester.pumpAndSettle();

      expect(launched.length, 1);
      expect(launched.single.scheme, 'https');
      expect(launched.single.toString(), contains('job-1'));
    });
  });

  group('AI-assisted create path (ADR-0035) is ADDITIVE', () {
    testWidgets('the manual Post button survives alongside "Create with AI"',
        (WidgetTester tester) async {
      await pump(tester);

      expect(find.text('Post'), findsOneWidget);
      expect(find.text(kAiPostLabel), findsOneWidget);

      await tester.tap(find.text(kAiPostLabel));
      await tester.pumpAndSettle();
      expect(aiOpens, <String?>[null], reason: 'null = start a fresh chat');
    });

    testWidgets('no resume card when there is nothing in progress',
        (WidgetTester tester) async {
      await pump(tester);
      expect(find.text(kResumeChatTitle), findsNothing);
    });

    testWidgets('an in-progress session surfaces the CROSS-DEVICE resume card, '
        'and tapping it resumes THAT session', (WidgetTester tester) async {
      await pump(
        tester,
        sessions: const <JobPostingChatSessionSummary>[
          JobPostingChatSessionSummary(
            id: 'web-session-7',
            status: 'active',
            roleTitle: 'CNC Setter',
          ),
        ],
      );

      expect(find.text(kResumeChatTitle), findsOneWidget);
      await tester.tap(find.text(kResumeChatTitle));
      await tester.pumpAndSettle();
      expect(aiOpens, <String?>['web-session-7']);
    });

    testWidgets('a PUBLISHED session is not offered for resume',
        (WidgetTester tester) async {
      await pump(
        tester,
        sessions: const <JobPostingChatSessionSummary>[
          JobPostingChatSessionSummary(id: 'done', status: 'published'),
        ],
      );
      expect(find.text(kResumeChatTitle), findsNothing);
    });

    testWidgets('without the AI callback wired, the screen is unchanged',
        (WidgetTester tester) async {
      await pump(tester, wireAi: false);

      expect(find.text('Post'), findsOneWidget);
      expect(find.text(kAiPostLabel), findsNothing);
      expect(find.text(kResumeChatTitle), findsNothing);
    });
  });
}
