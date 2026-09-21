// UI kit v3, decision D13 — the responsive contract for the chat profiling
// screen (spec §3.9: the Bada Bhai header, the green pack line, the transcript,
// the docked composer and the CTA / handover card).
//
// The chat is the one screen a worker spends minutes inside, on whatever phone
// they own, with whatever font size they set. So this pins the four things that
// have actually broken layouts before:
//  1. the SIZE × TEXT-SCALE matrix — nothing throws and the CTA is still there;
//  2. a SHORT phone with the KEYBOARD UP at 2.0 — the one state where the
//     transcript, the chips, the composer and the CTA all want the same pixels;
//  3. a TABLET — the column stops at the kit's width instead of stretching;
//  4. TAP TARGETS on a real handset.
//
// Plus D11: an option's raw `option_key` never reaches the glass.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart'
    show ChatOption, ChatProgress;
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/theme/onboarding_theme.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_repository.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_turn.dart';
import 'package:badabhai_worker_app/features/chat/presentation/bloc/chat_bloc.dart';
import 'package:badabhai_worker_app/features/chat/presentation/chat_profiling_screen.dart';

import '../../support/kit_matrix.dart';

class _MockChatRepository extends Mock implements ChatRepository {}

/// A model-suggested chip row: the KEY is a slug, the LABEL is what a worker
/// reads. The two differ on purpose — that is what makes the D11 assertion
/// meaningful.
const List<ChatOption> _kSuggestions = <ChatOption>[
  ChatOption(optionKey: 'llm_a', labelText: 'CNC turner'),
  ChatOption(optionKey: 'llm_b', labelText: 'Fitter'),
];

void main() {
  late _MockChatRepository repo;

  setUp(() async {
    await locator.reset();
    repo = _MockChatRepository();
    when(() => repo.ensureSession()).thenAnswer((_) async => null);
    locator.registerFactory<ChatBloc>(() => ChatBloc(repo));
  });

  tearDown(() async => locator.reset());

  /// Pumps the chat at [size] and [scale], with an optional [keyboard] up.
  ///
  /// Never `pumpAndSettle`: the transcript animates to the bottom on every
  /// append, and a settle on a screen that keeps scheduling frames is a test
  /// that times out rather than a test that passes.
  Future<void> pumpChat(
    WidgetTester tester, {
    required Size size,
    required double scale,
    double keyboard = 0,
  }) async {
    setKitSurface(tester, size, keyboard: keyboard);
    await tester.pumpWidget(
      kitTestApp(const ChatProfilingScreen(), textScale: scale),
    );
    await tester.pump(); // ensureSession resolves; the spinner drops
    await tester.pump(const Duration(milliseconds: 300));
  }

  /// Sends one worker line and lands a bot reply carrying [turn]'s extras.
  Future<void> exchange(WidgetTester tester, ChatTurn turn) async {
    when(
      () => repo.sendMessage(any(), submissionId: any(named: 'submissionId')),
    ).thenAnswer((_) async => turn);
    await tester.enterText(find.byType(TextField), 'lathe par kaam kiya');
    await tester.testTextInput.receiveAction(TextInputAction.send);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
  }

  group('D13 matrix — every phone shape at every font size', () {
    for (final Size size in kKitMatrixSizes) {
      for (final double scale in kKitMatrixTextScales) {
        testWidgets(
          'chat holds at ${size.width.toInt()}x${size.height.toInt()} @ ${scale}x',
          (WidgetTester tester) async {
            await pumpChat(tester, size: size, scale: scale);

            expect(
              tester.takeException(),
              isNull,
              reason: 'chat threw at $size, text x$scale',
            );
            // The composer and the CTA are the two things a worker must always
            // have: one to answer with, one to leave with.
            expect(find.byType(TextField), findsOneWidget);
            expect(find.text(kChatDoneNotReadyLabel), findsOneWidget);
          },
        );
      }
    }
  });

  testWidgets(
    'D13 small + keyboard — 320x568 @2.0 with the keyboard up keeps the '
    'composer and the CTA',
    (WidgetTester tester) async {
      await pumpChat(
        tester,
        size: const Size(320, 568),
        scale: 2.0,
        keyboard: 260,
      );
      await exchange(
        tester,
        const ChatTurn(
          reply: 'Kaunsi machine chalate hain?',
          suggestedOptions: _kSuggestions,
          progress: ChatProgress(answered: 2, total: 8),
        ),
      );

      expect(tester.takeException(), isNull);
      expect(find.byType(TextField), findsOneWidget);
      expect(find.text(kChatDoneNotReadyLabel), findsOneWidget);
      // The chips are the no-typing answer path — they must survive the squeeze
      // that the keyboard plus a 2.0 font puts on the bottom stack.
      expect(find.text('CNC turner'), findsOneWidget);
    },
  );

  testWidgets('D13 tablet — the chat column stops at the kit width', (
    WidgetTester tester,
  ) async {
    await pumpChat(tester, size: const Size(768, 1024), scale: 1.0);
    await exchange(tester, const ChatTurn(reply: 'Theek hai, aur bataiye.'));

    expect(tester.takeException(), isNull);
    // The composer sits inside the capped column, so its field can never be
    // wider than the column itself.
    expect(
      widthOf(tester, find.byType(TextField)),
      lessThanOrEqualTo(OnboardingLayout.maxContentWidth),
    );
    // A bubble keeps the kit's ~78% proportion of that column, not of a
    // 768px slab.
    expect(
      widthOf(tester, find.text('Theek hai, aur bataiye.')),
      lessThanOrEqualTo(OnboardingLayout.maxContentWidth * 0.78),
    );
  });

  testWidgets('D6 tap targets — every control clears 48dp at 360x640', (
    WidgetTester tester,
  ) async {
    await pumpChat(tester, size: const Size(360, 640), scale: 1.0);
    await exchange(
      tester,
      const ChatTurn(
        reply: 'Kaunsi machine chalate hain?',
        suggestedOptions: _kSuggestions,
      ),
    );

    // Covers the header Feedback link, the read-aloud speaker on the bot
    // bubble, the answer chips, the composer's mic/send and the CTA.
    await expectKitTapTargets(tester);
  });

  testWidgets('D8 focus — the composer focus ring is navy, not yellow', (
    WidgetTester tester,
  ) async {
    await pumpChat(tester, size: const Size(390, 844), scale: 1.0);

    final BorderSide focused =
        (tester
                    .widget<TextField>(find.byType(TextField))
                    .decoration!
                    .focusedBorder!
                as OutlineInputBorder)
            .borderSide;
    // Yellow is SELECTED (a picked card, a ticked box). A caret in the
    // composer is focus, and focus is shiftBlue at 1.8 (spec §3.3).
    expect(focused.color, OnboardingColors.shiftBlue);
    expect(focused.width, 1.8);
  });

  testWidgets('D11 real data — an option key never reaches the screen', (
    WidgetTester tester,
  ) async {
    await pumpChat(tester, size: const Size(390, 844), scale: 1.0);
    await exchange(
      tester,
      const ChatTurn(
        reply: 'Aap kya kaam karte hain?',
        suggestedOptions: _kSuggestions,
        occupationLabel: 'CNC turner',
        progress: ChatProgress(answered: 3, total: 8),
      ),
    );

    expect(find.text('CNC turner'), findsWidgets); // label + pinned pill
    expect(find.text('Fitter'), findsOneWidget);
    for (final String slug in <String>['llm_a', 'llm_b', 'kuch_aur']) {
      expect(
        find.textContaining(slug),
        findsNothing,
        reason: '$slug is a wire key, never worker-facing copy',
      );
    }
  });
}
