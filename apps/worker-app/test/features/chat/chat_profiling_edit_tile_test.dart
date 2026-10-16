import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart';
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/session/chat_turn_resume_store.dart';
import 'package:badabhai_worker_app/core/session/resume_import_signal.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_message.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_repository.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_session_opening.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_turn.dart';
import 'package:badabhai_worker_app/features/chat/presentation/bloc/chat_bloc.dart';
import 'package:badabhai_worker_app/features/chat/presentation/chat_profiling_screen.dart';
import 'package:badabhai_worker_app/features/chat/presentation/widgets/profiling_edit_tile.dart';

class _MockChatRepository extends Mock implements ChatRepository {}

const String _confirm = 'Experience 5 saal → 2 saal kar doon?';
const List<ChatOption> _haanNahi = <ChatOption>[
  ChatOption(optionKey: 'edit_confirm_yes', labelText: 'Haan'),
  ChatOption(optionKey: 'edit_confirm_no', labelText: 'Nahi'),
];

Map<String, dynamic> _row(
  String label,
  String op,
  String? before,
  String? after, {
  String? warning,
}) => <String, dynamic>{
  'field_label': label,
  'op': op,
  'before': before,
  'after': after,
  'warning': ?warning,
};

ProfilingEditProposal _proposal(List<Map<String, dynamic>> rows) =>
    ProfilingEditProposal.fromJson(<String, dynamic>{
      'proposal_id': '11111111-1111-4111-8111-111111111111',
      'rows': rows,
    })!;

ChatTurn _gate(ProfilingEditProposal? proposal) => ChatTurn(
  reply: _confirm,
  followups: const <String>['Haan', 'Nahi'],
  suggestedOptions: _haanNahi,
  inputMode: ChatInputMode.optionsOnly,
  profilingEdit: proposal,
);

/// ADR-0057 R10 (#2314) — the profiling chat's change/delete confirmation
/// tile, through the real chat screen.
void main() {
  group('parsing edit_proposal', () {
    test('an edit and a delete with its warning', () {
      final ProfilingEditProposal p = _proposal(<Map<String, dynamic>>[
        _row('Experience', 'edit', '5 saal', '2 saal'),
        _row('Training', 'delete', 'CNC Basics', null, warning: 'Ye wapas nahi aayega'),
      ]);
      expect(p.rows, hasLength(2));
      expect(p.rows[0].isDelete, isFalse);
      expect(p.rows[0].after, '2 saal');
      expect(p.rows[1].isDelete, isTrue);
      expect(p.rows[1].warning, 'Ye wapas nahi aayega');
    });

    test('rows that cannot be drawn honestly are dropped; none left = no tile', () {
      expect(
        ProfilingEditProposal.fromJson(<String, dynamic>{
          'proposal_id': 'x',
          'rows': <Object?>[
            _row('', 'edit', 'a', 'b'),
            _row('Skill', 'rename', 'a', 'b'),
            _row('Skill', 'edit', 'a', null),
            _row('Skill', 'delete', null, null),
            null,
          ],
        }),
        isNull,
      );
      expect(ProfilingEditProposal.fromJson(null), isNull);
      expect(ProfilingEditProposal.fromJson(<String, dynamic>{'rows': <Object?>[]}), isNull);
    });

    test('the chat reply carries it; the companion card shape is not mistaken for it', () {
      final ChatReply profiling = ChatReply.fromJson(<String, dynamic>{
        'reply': _confirm,
        'edit_proposal': <String, dynamic>{
          'proposal_id': 'p1',
          'rows': <Object?>[_row('Experience', 'edit', '5 saal', '2 saal')],
        },
      });
      expect(profiling.profilingEdit, isNotNull);
      expect(profiling.editProposal, isNull, reason: 'no expires_at / row_id');
    });
  });

  group('the tile on the chat screen', () {
    late _MockChatRepository repo;
    late InMemoryChatTurnResumeStore store;
    ChatTurn next = _gate(null);

    setUp(() async {
      repo = _MockChatRepository();
      store = InMemoryChatTurnResumeStore();
      await locator.reset();
      locator.registerFactory<ChatBloc>(() => ChatBloc(repo, turnResume: store));
      locator.registerLazySingleton<ResumeImportSignal>(ResumeImportSignal.new);
      when(() => repo.ensureSession()).thenAnswer(
        (_) async => const ChatSessionOpening(text: 'Aapka experience kitna hai?'),
      );
      when(() => repo.loadHistory()).thenAnswer((_) async => const <ChatMessage>[]);
      when(() => repo.latestSessionId()).thenAnswer((_) async => 's1');
      when(
        () => repo.sendMessage(
          any(),
          submissionId: any(named: 'submissionId'),
          answerSource: any(named: 'answerSource'),
        ),
      ).thenAnswer((Invocation i) async {
        final String text = i.positionalArguments.first as String;
        if (text == 'Haan' || text == 'Nahi') {
          return const ChatTurn(reply: 'Theek hai. Aap kahan kaam karte the?');
        }
        return next;
      });
    });

    tearDown(() async => locator.reset());

    Future<void> pumpChat(WidgetTester tester) async {
      tester.view.physicalSize = const Size(420, 900);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);
      final GoRouter router = GoRouter(
        initialLocation: '/chat',
        routes: <RouteBase>[
          GoRoute(path: '/chat', builder: (_, _) => const ChatProfilingScreen()),
        ],
      );
      addTearDown(router.dispose);
      await tester.pumpWidget(MaterialApp.router(routerConfig: router));
      await tester.pumpAndSettle();
    }

    Future<void> say(WidgetTester tester, String text) async {
      await tester.enterText(find.byType(TextField), text);
      await tester.testTextInput.receiveAction(TextInputAction.send);
      await tester.pumpAndSettle();
    }

    testWidgets('a single edit: field, old value struck through, new value', (
      WidgetTester tester,
    ) async {
      next = _gate(_proposal(<Map<String, dynamic>>[
        _row('Experience', 'edit', '5 saal', '2 saal'),
      ]));
      await pumpChat(tester);
      await say(tester, 'experience 2 saal hai');

      expect(find.byKey(kProfilingEditTileKey), findsOneWidget);
      expect(find.text('Experience'), findsOneWidget);
      final Text before = tester.widget<Text>(find.text('5 saal'));
      expect(before.style!.decoration, TextDecoration.lineThrough);
      expect(find.text('2 saal'), findsOneWidget);
      // The tile's buttons replace the chip row; no duplicate Haan / Nahi.
      expect(find.text('Haan'), findsOneWidget);
      expect(find.text('Nahi'), findsOneWidget);
      // The keyboard is locked while the tile is pending.
      expect(find.byType(TextField), findsNothing);
    });

    testWidgets('a delete shows the old value and its warning', (
      WidgetTester tester,
    ) async {
      next = _gate(_proposal(<Map<String, dynamic>>[
        _row('Training', 'delete', 'CNC Basics', null, warning: 'Ye wapas nahi aayega'),
      ]));
      await pumpChat(tester);
      await say(tester, 'training hata do');

      expect(find.byKey(kProfilingEditTileKey), findsOneWidget);
      final Text before = tester.widget<Text>(find.text('CNC Basics'));
      expect(before.style!.decoration, TextDecoration.lineThrough);
      expect(find.text('Ye wapas nahi aayega'), findsOneWidget);
      expect(find.byIcon(Icons.warning_rounded), findsOneWidget);
      expect(find.byIcon(Icons.arrow_forward_rounded), findsNothing);
    });

    testWidgets('multiple rows, each drawn', (WidgetTester tester) async {
      next = _gate(_proposal(<Map<String, dynamic>>[
        _row('Experience', 'edit', '5 saal', '2 saal'),
        _row('Training', 'delete', 'CNC Basics', null, warning: 'Ye wapas nahi aayega'),
        _row('Shift', 'edit', 'Din', 'Raat'),
      ]));
      await pumpChat(tester);
      await say(tester, 'sab badal do');

      for (final String t in <String>[
        'Experience', '5 saal', '2 saal', 'Training', 'CNC Basics',
        'Ye wapas nahi aayega', 'Shift', 'Din', 'Raat',
      ]) {
        expect(find.text(t), findsOneWidget, reason: t);
      }
    });

    testWidgets('Haan sends the SAME chip the text version sends, then the tile goes', (
      WidgetTester tester,
    ) async {
      next = _gate(_proposal(<Map<String, dynamic>>[
        _row('Experience', 'edit', '5 saal', '2 saal'),
      ]));
      await pumpChat(tester);
      await say(tester, 'experience 2 saal hai');

      await tester.tap(find.byKey(kProfilingEditYesKey));
      await tester.pumpAndSettle();

      verify(
        () => repo.sendMessage(
          'Haan',
          submissionId: any(named: 'submissionId'),
          answerSource: any(named: 'answerSource'),
        ),
      ).called(1);
      expect(find.byKey(kProfilingEditTileKey), findsNothing);
      expect(find.text('Theek hai. Aap kahan kaam karte the?'), findsOneWidget);
      expect(find.byType(TextField), findsOneWidget, reason: 'keyboard back');
    });

    testWidgets('no edit_proposal (an older server): the text + chips, exactly as before', (
      WidgetTester tester,
    ) async {
      next = _gate(null);
      await pumpChat(tester);
      await say(tester, 'experience 2 saal hai');

      expect(find.byKey(kProfilingEditTileKey), findsNothing);
      expect(find.text(_confirm), findsOneWidget);
      expect(find.text('Haan'), findsOneWidget);
      expect(find.text('Nahi'), findsOneWidget);
    });

    testWidgets('re-hydrated (app reopened mid-chat): the tile is drawn again', (
      WidgetTester tester,
    ) async {
      next = _gate(_proposal(<Map<String, dynamic>>[
        _row('Experience', 'edit', '5 saal', '2 saal'),
      ]));
      await pumpChat(tester);
      await say(tester, 'experience 2 saal hai');
      expect(find.byKey(kProfilingEditTileKey), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      await tester.pumpAndSettle();
      // The remembered turn is written fire-and-forget.
      final ChatTurnResumeState? saved = await store.read();
      expect(saved?.profilingEditJson, isNotNull);

      // Cold start: a RESUME serves no opening; the transcript is redrawn.
      when(() => repo.ensureSession()).thenAnswer((_) async => null);
      when(() => repo.loadHistory()).thenAnswer(
        (_) async => const <ChatMessage>[
          ChatMessage(text: 'Aapka experience kitna hai?', fromWorker: false),
          ChatMessage(text: 'experience 2 saal hai', fromWorker: true),
          ChatMessage(text: _confirm, fromWorker: false),
        ],
      );
      await pumpChat(tester);

      expect(find.byKey(kProfilingEditTileKey), findsOneWidget);
      expect(find.text('2 saal'), findsOneWidget);
      expect(find.byType(TextField), findsNothing);
    });
  });
}
