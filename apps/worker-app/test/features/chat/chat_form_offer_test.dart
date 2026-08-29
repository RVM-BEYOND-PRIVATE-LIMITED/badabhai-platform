// #1339/#1340 — the CNC-turner handover card. `POST /chat/message` can end an
// interview by handing the worker to a trade-specific form (`form_offer`);
// this pins the whole chain: JSON -> ChatReply -> ChatTurn -> ChatState -> the
// card + its CTA, its MUTUAL EXCLUSION with the "build my profile" CTA
// (extraction_ready is false on this turn precisely so the two can never both
// render), and the retry/replay path.
//
// Split the same way #421 is (chat_extraction_ready_test.dart /
// chat_done_gate_screen_test.dart): the bloc half here imports no screen, the
// screen half pulls in router.dart.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart';
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/widgets/bb_chat_bubble.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_repository.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_turn.dart';
import 'package:badabhai_worker_app/features/chat/presentation/bloc/chat_bloc.dart';
import 'package:badabhai_worker_app/features/chat/presentation/chat_profiling_screen.dart';
import 'package:badabhai_worker_app/router.dart';

class MockChatRepository extends Mock implements ChatRepository {}

/// The exact fixture from the issue's wire contract.
const FormOffer kCncOffer = FormOffer(
  kind: 'cnc_turner',
  headline: 'CNC turner profile detected',
  ctaLabel: 'Form bharkar resume pura karein',
);

/// Marker for the screen [Routes.tradeForm] must reach.
const String kTradeFormMarker = 'TRADE-FORM';

void main() {
  late MockChatRepository repo;

  setUp(() async {
    repo = MockChatRepository();
    await locator.reset();
    locator.registerFactory<ChatBloc>(() => ChatBloc(repo));
    when(() => repo.ensureSession()).thenAnswer((_) async => null);
  });

  tearDown(() async => locator.reset());

  // ------------------------------------------------------------------- bloc

  group('ChatState.formOffer (#1339/#1340)', () {
    test('a reply carrying form_offer sets it on the state', () async {
      when(() =>
              repo.sendMessage(any(), submissionId: any(named: 'submissionId')))
          .thenAnswer((_) async => const ChatTurn(
                reply: 'CNC turner profile detected. Ab form bharkar resume '
                    'pura karein.',
                extractionReady: false,
                formOffer: kCncOffer,
              ));
      final ChatBloc bloc = ChatBloc(repo);
      addTearDown(bloc.close);

      expect(bloc.state.formOffer, isNull, reason: 'nothing said yet');
      bloc.add(const ChatMessageSent('CNC turner hun'));
      await Future<void>.delayed(const Duration(milliseconds: 50));

      expect(bloc.state.formOffer, kCncOffer);
      expect(bloc.state.extractionReady, isFalse,
          reason: 'the wire contract sets both together on a handover turn');
    });

    test('an ordinary reply (no form_offer) leaves the state null', () async {
      when(() =>
              repo.sendMessage(any(), submissionId: any(named: 'submissionId')))
          .thenAnswer((_) async => const ChatTurn(reply: 'Aur bataiye.'));
      final ChatBloc bloc = ChatBloc(repo);
      addTearDown(bloc.close);

      bloc.add(const ChatMessageSent('Welder hun'));
      await Future<void>.delayed(const Duration(milliseconds: 50));

      expect(bloc.state.formOffer, isNull);
    });

    test(
        'TURN-SCOPED: a later ordinary turn clears a previous handover card '
        '(never sticky like extractionReady)', () async {
      int calls = 0;
      when(() =>
              repo.sendMessage(any(), submissionId: any(named: 'submissionId')))
          .thenAnswer((_) async {
        calls++;
        return calls == 1
            ? const ChatTurn(reply: 'r1', formOffer: kCncOffer)
            : const ChatTurn(reply: 'r2');
      });
      final ChatBloc bloc = ChatBloc(repo);
      addTearDown(bloc.close);

      bloc.add(const ChatMessageSent('one'));
      await Future<void>.delayed(const Duration(milliseconds: 50));
      expect(bloc.state.formOffer, kCncOffer);

      bloc.add(const ChatMessageSent('two'));
      await Future<void>.delayed(const Duration(milliseconds: 50));
      expect(bloc.state.formOffer, isNull,
          reason: 'formOffer must never survive past the turn that offered it');
    });

    test('a RETRIED submit that replays the same cached offer redraws it',
        () async {
      int calls = 0;
      when(() => repo.sendMessage('cnc turner',
          submissionId: any(named: 'submissionId'))).thenAnswer((_) async {
        calls++;
        if (calls == 1) throw const NetworkFailure();
        // The server's replay path returns the SAME cached offer (acceptance
        // criterion): a flaky link must not lose the card.
        return const ChatTurn(reply: 'r', formOffer: kCncOffer);
      });
      final ChatBloc bloc = ChatBloc(repo);
      addTearDown(bloc.close);

      bloc.add(const ChatMessageSent('cnc turner'));
      await Future<void>.delayed(const Duration(milliseconds: 50));
      expect(bloc.state.formOffer, isNull,
          reason: 'the failed first attempt set nothing');

      // The worker taps the failed bubble (index 1 — after the opener at 0).
      bloc.add(const ChatRetryRequested(1));
      await Future<void>.delayed(const Duration(milliseconds: 50));

      expect(bloc.state.formOffer, kCncOffer,
          reason: 'the replayed response redraws the same card');
    });

    test('a VOICE merge never carries a card and clears a stale one',
        () async {
      when(() =>
              repo.sendMessage(any(), submissionId: any(named: 'submissionId')))
          .thenAnswer(
              (_) async => const ChatTurn(reply: 'r1', formOffer: kCncOffer));
      final ChatBloc bloc = ChatBloc(repo);
      addTearDown(bloc.close);

      bloc.add(const ChatMessageSent('one'));
      await Future<void>.delayed(const Duration(milliseconds: 50));
      expect(bloc.state.formOffer, kCncOffer);

      bloc.add(const ChatVoiceMerged(
        transcript: 'CNC operator machine par',
        reply: 'Theek hai.',
      ));
      await Future<void>.delayed(const Duration(milliseconds: 30));
      expect(bloc.state.formOffer, isNull);
    });
  });

  // ----------------------------------------------------------------- screen

  group('the handover card renders + suppresses the old CTA (#1340)', () {
    Future<GoRouter> pumpChat(WidgetTester tester) async {
      tester.view.physicalSize = const Size(500, 1000);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      final GoRouter router = GoRouter(
        initialLocation: Routes.chatProfiling,
        routes: <RouteBase>[
          GoRoute(
            path: Routes.chatProfiling,
            builder: (_, __) => const ChatProfilingScreen(),
          ),
          GoRoute(
            path: Routes.tradeForm,
            builder: (_, __) => const Scaffold(body: Text(kTradeFormMarker)),
          ),
        ],
      );
      await tester.pumpWidget(MaterialApp.router(routerConfig: router));
      await tester.pump();
      await tester.pumpAndSettle();
      return router;
    }

    Future<void> sendOneMessage(WidgetTester tester, String text) async {
      await tester.enterText(find.byType(TextField), text);
      await tester.pump(); // composer switches Mic→Send once there is text
      await tester.tap(find.byIcon(Icons.send_rounded));
      await tester.pumpAndSettle();
    }

    testWidgets(
        'a form_offer turn renders the headline + CTA label, and EXACTLY the '
        'one CTA', (WidgetTester tester) async {
      when(() =>
              repo.sendMessage(any(), submissionId: any(named: 'submissionId')))
          .thenAnswer((_) async => const ChatTurn(
                reply: 'CNC turner profile detected. Ab form bharkar resume '
                    'pura karein.',
                extractionReady: false,
                formOffer: kCncOffer,
              ));
      await pumpChat(tester);
      await sendOneMessage(tester, 'CNC turner hun');

      expect(find.text(kCncOffer.headline), findsOneWidget);
      expect(find.text(kCncOffer.ctaLabel), findsOneWidget);
      // The old CTA must NOT also appear — one card, one button, never two.
      expect(find.text(kChatDoneReadyLabel), findsNothing);
      expect(find.text(kChatDoneNotReadyLabel), findsNothing);
    });

    testWidgets('tapping the CTA navigates to Routes.tradeForm',
        (WidgetTester tester) async {
      when(() =>
              repo.sendMessage(any(), submissionId: any(named: 'submissionId')))
          .thenAnswer((_) async =>
              const ChatTurn(reply: 'ok', formOffer: kCncOffer));
      await pumpChat(tester);
      await sendOneMessage(tester, 'CNC turner hun');

      await tester.tap(find.text(kCncOffer.ctaLabel));
      await tester.pumpAndSettle();

      expect(find.text(kTradeFormMarker), findsOneWidget);
    });

    testWidgets(
        'a normal turn (form_offer null) is unchanged — the old CTA still '
        'renders', (WidgetTester tester) async {
      when(() =>
              repo.sendMessage(any(), submissionId: any(named: 'submissionId')))
          .thenAnswer((_) async => const ChatTurn(reply: 'Aur bataiye.'));
      await pumpChat(tester);
      await sendOneMessage(tester, 'Welder hun');

      expect(find.text(kChatDoneNotReadyLabel), findsOneWidget);
      expect(find.text(kCncOffer.headline), findsNothing);
      expect(find.text(kCncOffer.ctaLabel), findsNothing);
    });

    testWidgets(
        'a retried/replayed response carrying the same form_offer redraws '
        'the same card', (WidgetTester tester) async {
      int calls = 0;
      when(() => repo.sendMessage('CNC turner hun',
          submissionId: any(named: 'submissionId'))).thenAnswer((_) async {
        calls++;
        if (calls == 1) throw const NetworkFailure();
        return const ChatTurn(reply: 'ok', formOffer: kCncOffer);
      });
      await pumpChat(tester);
      await sendOneMessage(tester, 'CNC turner hun');
      expect(find.text(kChatSendFailedLabel), findsOneWidget);
      expect(find.text(kCncOffer.headline), findsNothing);

      // Tap the failed bubble to retry — same submission, replayed response.
      await tester.tap(find.text(kChatSendFailedLabel));
      await tester.pumpAndSettle();

      expect(find.text(kCncOffer.headline), findsOneWidget);
      expect(find.text(kCncOffer.ctaLabel), findsOneWidget);
      expect(find.text(kChatDoneReadyLabel), findsNothing);
      expect(find.text(kChatDoneNotReadyLabel), findsNothing);
    });
  });
}
