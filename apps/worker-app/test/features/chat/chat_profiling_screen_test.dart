import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_repository.dart';
import 'package:badabhai_worker_app/features/chat/presentation/bloc/chat_bloc.dart';
import 'package:badabhai_worker_app/features/chat/presentation/chat_profiling_screen.dart';

class MockChatRepository extends Mock implements ChatRepository {}

void main() {
  late MockChatRepository repo;

  setUp(() async {
    repo = MockChatRepository();
    // Swap the real graph for a ChatBloc backed by a mock repo we control. The
    // screen resolves `locator<ChatBloc>()` exactly as in production.
    // `GetIt.reset()` is async — await it so the re-registration below is in
    // place before the screen mounts and the BlocProvider calls
    // `locator<ChatBloc>()` (otherwise the factory can be momentarily absent).
    await locator.reset();
    locator.registerFactory<ChatBloc>(() => ChatBloc(repo));
    // Session opens instantly so the spinner drops and the list mounts.
    when(() => repo.ensureSession()).thenAnswer((_) async {});
  });

  tearDown(() async => locator.reset());

  /// A scroll controller hanging off the message ListView (the long transcript)
  /// — there is no separate controller in the composer, so the only attached
  /// `Scrollable` is the chat list.
  ScrollController listController(WidgetTester tester) {
    final Scrollable scrollable = tester.widget<Scrollable>(
      find.byType(Scrollable).first,
    );
    return scrollable.controller!;
  }

  /// Pumps the screen at a small surface so a handful of bubbles overflow the
  /// viewport and the list is actually scrollable.
  Future<void> pumpScreen(WidgetTester tester) async {
    tester.view.physicalSize = const Size(400, 700);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await tester.pumpWidget(const MaterialApp(home: ChatProfilingScreen()));
    await tester.pump(); // ChatStarted -> ensureSession resolves, spinner drops
    await tester.pumpAndSettle();
  }

  /// Fills the transcript with worker messages so the list overflows. Each send
  /// resolves its bot reply immediately.
  Future<void> fillTranscript(WidgetTester tester, int count) async {
    when(() => repo.sendMessage(any())).thenAnswer((_) async => 'ok bhai');
    for (int i = 0; i < count; i++) {
      await tester.enterText(find.byType(TextField), 'msg $i');
      await tester.testTextInput.receiveAction(TextInputAction.send);
      await tester.pumpAndSettle();
    }
  }

  testWidgets('own message always snaps the list to the bottom', (
    WidgetTester tester,
  ) async {
    await pumpScreen(tester);
    await fillTranscript(tester, 12);

    // Scroll up so we are well away from the bottom.
    final ScrollController controller = listController(tester);
    controller.jumpTo(0);
    await tester.pumpAndSettle();
    expect(controller.position.pixels, 0);

    // Send the worker's own message — it must follow them down regardless.
    when(() => repo.sendMessage(any())).thenAnswer((_) async => 'ok bhai');
    await tester.enterText(find.byType(TextField), 'my own line');
    await tester.testTextInput.receiveAction(TextInputAction.send);
    await tester.pumpAndSettle();

    expect(
      controller.position.pixels,
      controller.position.maxScrollExtent,
      reason: 'own message should animate to the bottom',
    );
    // No pill — we are pinned to the bottom.
    expect(find.text('Naye message'), findsNothing);
  });

  testWidgets(
    'received message while scrolled up shows the pill and does not auto-scroll',
    (WidgetTester tester) async {
      await pumpScreen(tester);
      await fillTranscript(tester, 12);

      // Hold the bot reply open so we can scroll up before it lands.
      final Completer<String> reply = Completer<String>();
      when(() => repo.sendMessage(any())).thenAnswer((_) => reply.future);

      await tester.enterText(find.byType(TextField), 'trigger');
      await tester.testTextInput.receiveAction(TextInputAction.send);
      await tester.pumpAndSettle(); // worker message appended + scrolled down

      // Scroll up, away from the bottom.
      final ScrollController controller = listController(tester);
      controller.jumpTo(0);
      await tester.pumpAndSettle();
      final double before = controller.position.pixels;
      expect(before, 0);

      // Bot reply lands while we are scrolled up.
      reply.complete('bada bhai replies');
      await tester.pumpAndSettle();

      // Pill appears, list stays put (no auto-scroll).
      expect(find.text('Naye message'), findsOneWidget);
      expect(controller.position.pixels, before);
      expect(
        controller.position.pixels,
        lessThan(controller.position.maxScrollExtent),
      );
    },
  );

  testWidgets('tapping the pill scrolls to the bottom and hides it', (
    WidgetTester tester,
  ) async {
    await pumpScreen(tester);
    await fillTranscript(tester, 12);

    final Completer<String> reply = Completer<String>();
    when(() => repo.sendMessage(any())).thenAnswer((_) => reply.future);

    await tester.enterText(find.byType(TextField), 'trigger');
    await tester.testTextInput.receiveAction(TextInputAction.send);
    await tester.pumpAndSettle();

    final ScrollController controller = listController(tester);
    controller.jumpTo(0);
    await tester.pumpAndSettle();

    reply.complete('bada bhai replies');
    await tester.pumpAndSettle();
    expect(find.text('Naye message'), findsOneWidget);

    // Tap the pill -> animate to bottom + clear the flag.
    await tester.tap(find.text('Naye message'));
    await tester.pumpAndSettle();

    expect(find.text('Naye message'), findsNothing);
    expect(controller.position.pixels, controller.position.maxScrollExtent);
  });
}
