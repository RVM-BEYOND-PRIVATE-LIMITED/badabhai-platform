// #1364 — the FAB-overlap half. ChatProfilingScreen uses a raw Scaffold (not
// BbScaffold), so it never otherwise participates in the bottomBarInset
// mechanism the app-wide FeedbackFabOverlay reads to float clear of a page's
// bottom content. On a real device the handover card's headline collided with
// the FAB because of this. This pins the LOCAL measure-and-publish discipline
// added to `_ChatViewState`: a non-zero inset once the composer/CTA segment is
// on screen, a TALLER inset for the taller #1339/#1340 handover card than the
// ordinary CTA row, and a reset to 0 once the screen leaves.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart';
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/widgets/bottom_bar_inset.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_repository.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_turn.dart';
import 'package:badabhai_worker_app/features/chat/presentation/bloc/chat_bloc.dart';
import 'package:badabhai_worker_app/features/chat/presentation/chat_profiling_screen.dart';
import 'package:badabhai_worker_app/router.dart';

class MockChatRepository extends Mock implements ChatRepository {}

const FormOffer kCncOffer = FormOffer(
  kind: 'cnc_turner',
  headline: 'CNC turner profile detected',
  ctaLabel: 'Form bharkar resume pura karein',
);

void main() {
  late MockChatRepository repo;

  setUp(() async {
    repo = MockChatRepository();
    await locator.reset();
    locator.registerFactory<ChatBloc>(() => ChatBloc(repo));
    when(() => repo.ensureSession()).thenAnswer((_) async => null);
    // Isolate each test from whatever the previous one published.
    bottomBarInset.value = 0;
  });

  tearDown(() async {
    await locator.reset();
    bottomBarInset.value = 0;
  });

  Future<void> pumpChat(WidgetTester tester) async {
    tester.view.physicalSize = const Size(400, 700);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await tester.pumpWidget(const MaterialApp(home: ChatProfilingScreen()));
    await tester.pump(); // ChatStarted -> ensureSession resolves, spinner drops
    await tester.pumpAndSettle();
  }

  Future<void> sendOneMessage(WidgetTester tester, String text) async {
    await tester.enterText(find.byType(TextField), text);
    await tester.pump(); // composer switches Mic→Send once there is text
    await tester.tap(find.byIcon(Icons.send_rounded));
    await tester.pumpAndSettle();
  }

  testWidgets(
      'publishes a non-zero inset once the composer/CTA segment is on '
      'screen', (WidgetTester tester) async {
    await pumpChat(tester);
    expect(bottomBarInset.value, greaterThan(0));
  });

  testWidgets(
      'a form_offer (handover card) turn publishes a TALLER inset than the '
      'ordinary CTA row', (WidgetTester tester) async {
    await pumpChat(tester);
    final double ordinaryInset = bottomBarInset.value;

    when(() =>
            repo.sendMessage(any(), submissionId: any(named: 'submissionId')))
        .thenAnswer((_) async => const ChatTurn(
              reply: 'CNC turner profile detected. Ab form bharkar resume '
                  'pura karein.',
              extractionReady: false,
              formOffer: kCncOffer,
            ));
    await sendOneMessage(tester, 'CNC turner hun');

    expect(
      bottomBarInset.value,
      greaterThan(ordinaryInset),
      reason: 'the handover card is taller than the ordinary CTA row, so it '
          'must push the FAB higher, not leave it at the shorter float',
    );
  });

  testWidgets('the inset resets to 0 once the screen is popped',
      (WidgetTester tester) async {
    tester.view.physicalSize = const Size(400, 700);
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
          builder: (_, __) => const Scaffold(body: Text('ELSEWHERE')),
        ),
      ],
    );
    await tester.pumpWidget(MaterialApp.router(routerConfig: router));
    await tester.pump();
    await tester.pumpAndSettle();
    expect(bottomBarInset.value, greaterThan(0));

    // `go`, not `push` — a pushed route keeps the chat screen mounted
    // (just obscured) so it never disposes; `go` replaces the stack, which
    // is what actually tears the chat screen down.
    router.go(Routes.tradeForm);
    await tester.pumpAndSettle();

    expect(bottomBarInset.value, 0,
        reason: 'the chat screen left; it must stop claiming the inset it '
            'published');
  });
}
