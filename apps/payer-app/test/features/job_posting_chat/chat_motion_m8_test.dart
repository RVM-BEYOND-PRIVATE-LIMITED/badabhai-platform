import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:get_it/get_it.dart';

import 'package:payer_app/core/auth/payer_token_store.dart';
import 'package:payer_app/core/data/job_posting_chat_models.dart';
import 'package:payer_app/core/data/mock_payer_api_client.dart';
import 'package:payer_app/core/data/models.dart';
import 'package:payer_app/core/di/locator.dart';
import 'package:payer_app/core/theme/app_colors.dart';
import 'package:payer_app/core/widgets/bb_chat_bubble.dart';
import 'package:payer_app/core/widgets/bb_rise_in.dart';
import 'package:payer_app/core/widgets/bb_typing_dots.dart';
import 'package:payer_app/features/job_posting_chat/domain/job_posting_chat_repository.dart';
import 'package:payer_app/features/job_posting_chat/presentation/bloc/job_posting_chat_bloc.dart';
import 'package:payer_app/features/job_posting_chat/presentation/job_posting_chat_screen.dart';

/// #2596 (M8) — the AI job-posting chat's motion:
///  - Send is disabled while the input is empty;
///  - the typing dots are on screen — and pulse — only while a reply is
///    awaited (still under reduced motion);
///  - a NEW bubble rises in once (180ms, ≤6px); the opener does not;
///  - a successful publish hands the posting id to `onPostedJob` (the shell
///    lands on Jobs with that card highlighted).
class _FakeRepo implements JobPostingChatRepository {
  final List<String> sent = <String>[];

  /// When set, the next reply waits on it — the "waiting for a reply" window.
  Completer<JobPostingChatTurn>? pending;

  @override
  String? get sessionId => 'session-1';

  @override
  Future<JobPostingChatTurn?> openSession() async => const JobPostingChatTurn(
        sessionId: 'session-1',
        reply: 'Kaunsa kaam?',
      );

  @override
  void resumeSession(String id) {}

  @override
  Future<JobPostingChatTurn> sendMessage(String text) {
    sent.add(text);
    final Completer<JobPostingChatTurn>? wait = pending;
    if (wait != null) return wait.future;
    return Future<JobPostingChatTurn>.value(const JobPostingChatTurn(
      sessionId: 'session-1',
      reply: 'Kitne log?',
    ));
  }

  @override
  Future<JobPostingChatTranscript?> loadTranscript() async => null;

  @override
  Future<List<JobPostingChatSessionSummary>> listSessions() async =>
      const <JobPostingChatSessionSummary>[];

  @override
  Future<PublishJobResult> publish({String? roleKind, String? area}) async =>
      const PublishJobResult(jobPostingId: 'job-9');
}

void main() {
  late _FakeRepo repo;

  setUp(() async {
    await GetIt.instance.reset();
    setupLocator(
      apiClient: MockPayerApiClient(),
      secureStore: InMemoryKeyValueStore(),
    );
    repo = _FakeRepo();
    locator.unregister<JobPostingChatBloc>();
    locator.registerFactory<JobPostingChatBloc>(() => JobPostingChatBloc(repo));
  });

  Future<void> pumpChat(
    WidgetTester tester, {
    bool reduced = true,
    VoidCallback? onBack,
    VoidCallback? onPublished,
    ValueChanged<String>? onPostedJob,
  }) async {
    tester.view.physicalSize = const Size(360, 640);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        builder: (BuildContext context, Widget? app) => MediaQuery(
          data: MediaQuery.of(context).copyWith(disableAnimations: reduced),
          child: app!,
        ),
        home: Scaffold(
          body: JobPostingChatScreen(
            onBack: onBack ?? () {},
            onPublished: onPublished,
            onPostedJob: onPostedJob,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  Material send(WidgetTester tester) =>
      tester.widget<Material>(find.byKey(kJobChatSendKey));

  Future<void> type(WidgetTester tester, String text) async {
    await tester.enterText(find.byType(TextField), text);
    await tester.pump();
  }

  group('Send is disabled while the input is empty', () {
    testWidgets('empty or blank: disabled, and a tap sends nothing',
        (WidgetTester tester) async {
      await pumpChat(tester);

      expect(send(tester).color, AppColors.disabled);
      await tester.tap(find.byKey(kJobChatSendKey));
      await tester.pump();
      expect(repo.sent, isEmpty);

      await type(tester, '   ');
      expect(send(tester).color, AppColors.disabled);
      await tester.tap(find.byKey(kJobChatSendKey));
      await tester.pump();
      expect(repo.sent, isEmpty);
    });

    testWidgets('typed: enabled, sends, and clears back to disabled',
        (WidgetTester tester) async {
      await pumpChat(tester);

      await type(tester, 'CNC Setter');
      expect(send(tester).color, AppColors.blue);
      await tester.tap(find.byKey(kJobChatSendKey));
      await tester.pumpAndSettle();

      expect(repo.sent, <String>['CNC Setter']);
      expect(send(tester).color, AppColors.disabled);
      expect(tester.takeException(), isNull);
    });
  });

  group('typing indicator — only while waiting for a reply', () {
    testWidgets('shown while the reply is pending, gone once it lands',
        (WidgetTester tester) async {
      await pumpChat(tester);
      expect(find.byType(BbTypingDots), findsNothing);

      repo.pending = Completer<JobPostingChatTurn>();
      await type(tester, 'CNC Setter');
      await tester.tap(find.byKey(kJobChatSendKey));
      // Reduced motion: the dots stand still, so the tree settles.
      await tester.pumpAndSettle();

      expect(find.byType(BbTypingDots), findsOneWidget);
      expect(find.text(kJobChatTypingLabel), findsOneWidget);

      repo.pending!.complete(const JobPostingChatTurn(
        sessionId: 'session-1',
        reply: 'Kitne log?',
      ));
      await tester.pumpAndSettle();

      expect(find.byType(BbTypingDots), findsNothing);
      expect(find.text('Kitne log?'), findsOneWidget);
    });

    List<double> dotOpacities(WidgetTester tester) => tester
        .widgetList<Opacity>(find.descendant(
          of: find.byType(BbTypingDots),
          matching: find.byType(Opacity),
        ))
        .map((Opacity o) => o.opacity)
        .toList();

    testWidgets('the dots pulse in turn with animations on',
        (WidgetTester tester) async {
      await pumpChat(tester, reduced: false);
      repo.pending = Completer<JobPostingChatTurn>();
      await type(tester, 'CNC Setter');
      await tester.tap(find.byKey(kJobChatSendKey));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      final List<double> a = dotOpacities(tester);
      await tester.pump(const Duration(milliseconds: 300));
      final List<double> b = dotOpacities(tester);

      expect(a, hasLength(3));
      expect(a, isNot(equals(b)), reason: 'the dots move while waiting');
      // Out of step: not all three at the same strength.
      expect(a.toSet().length, greaterThan(1));
      for (final double o in <double>[...a, ...b]) {
        expect(o, inInclusiveRange(0.4, 1.0));
      }

      // The reply lands → the indicator (and its loop) is gone.
      repo.pending!.complete(const JobPostingChatTurn(
        sessionId: 'session-1',
        reply: 'Kitne log?',
      ));
      await tester.pumpAndSettle();
      expect(find.byType(BbTypingDots), findsNothing);
    });

    testWidgets('reduced motion: the dots stand still at full strength',
        (WidgetTester tester) async {
      await pumpChat(tester);
      repo.pending = Completer<JobPostingChatTurn>();
      await type(tester, 'CNC Setter');
      await tester.tap(find.byKey(kJobChatSendKey));
      await tester.pumpAndSettle();

      expect(dotOpacities(tester), <double>[1, 1, 1]);
      expect(tester.hasRunningAnimations, isFalse);
      repo.pending!.complete(const JobPostingChatTurn(
        sessionId: 'session-1',
        reply: 'ok',
      ));
      await tester.pumpAndSettle();
    });
  });

  group('message entrance — a new bubble rises once', () {
    BbRiseIn riseOf(WidgetTester tester, String text) =>
        tester.widget<BbRiseIn>(
          find.ancestor(of: find.text(text), matching: find.byType(BbRiseIn)),
        );

    /// The bubble's rise offset: the nearest Transform above its text.
    double liftOf(WidgetTester tester, String text) => tester
        .widget<Transform>(find
            .ancestor(of: find.text(text), matching: find.byType(Transform))
            .first)
        .transform
        .getTranslation()
        .y;

    testWidgets('the sent bubble and the reply rise 180ms; the opener does not',
        (WidgetTester tester) async {
      await pumpChat(tester, reduced: false);
      expect(riseOf(tester, 'Kaunsa kaam?').animate, isFalse);

      repo.pending = Completer<JobPostingChatTurn>();
      await type(tester, 'CNC Setter');
      await tester.tap(find.byKey(kJobChatSendKey));
      await tester.pump();

      expect(riseOf(tester, 'CNC Setter').animate, isTrue);
      await tester.pump(const Duration(milliseconds: 60));
      final double mid = liftOf(tester, 'CNC Setter');
      expect(mid, greaterThan(0));
      expect(mid, lessThanOrEqualTo(6), reason: 'at most 6px of travel');
      await tester.pump(const Duration(milliseconds: 150));
      expect(liftOf(tester, 'CNC Setter'), 0);

      repo.pending!.complete(const JobPostingChatTurn(
        sessionId: 'session-1',
        reply: 'Kitne log?',
      ));
      await tester.pump();
      await tester.pump();
      expect(riseOf(tester, 'Kitne log?').animate, isTrue);
      await tester.pumpAndSettle();
      expect(liftOf(tester, 'Kitne log?'), 0);
      // Every bubble is still the same bubble widget underneath.
      expect(find.byType(BbChatBubble), findsNWidgets(3));
    });

    testWidgets('reduced motion: new bubbles are simply there',
        (WidgetTester tester) async {
      await pumpChat(tester);
      await type(tester, 'CNC Setter');
      await tester.tap(find.byKey(kJobChatSendKey));
      await tester.pump();
      await tester.pump();
      expect(liftOf(tester, 'CNC Setter'), 0);
      await tester.pumpAndSettle();
    });
  });

  group('publish → land on Jobs with the new posting', () {
    Future<void> publish(WidgetTester tester) async {
      BlocProvider.of<JobPostingChatBloc>(
        tester.element(find.byType(ListView)),
      ).add(const JobPostingChatPublishRequested());
      await tester.pumpAndSettle();
    }

    testWidgets('hands the posting id to onPostedJob (and only that)',
        (WidgetTester tester) async {
      final List<String> landed = <String>[];
      int backs = 0;
      int published = 0;
      await pumpChat(
        tester,
        onBack: () => backs++,
        onPublished: () => published++,
        onPostedJob: landed.add,
      );

      await publish(tester);

      expect(landed, <String>['job-9']);
      expect(backs, 0);
      expect(published, 0);
      expect(find.text('Posted'), findsOneWidget);
    });

    testWidgets('without onPostedJob the old pair still runs',
        (WidgetTester tester) async {
      int backs = 0;
      int published = 0;
      await pumpChat(
        tester,
        onBack: () => backs++,
        onPublished: () => published++,
      );

      await publish(tester);

      expect(published, 1);
      expect(backs, 1);
    });
  });
}
