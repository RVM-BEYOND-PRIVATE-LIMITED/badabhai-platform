import 'dart:convert';

import 'package:bloc_test/bloc_test.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/session/session_repository.dart';
import 'package:badabhai_worker_app/features/chat/data/chat_repository_impl.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_message.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_repository.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_session_opening.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_turn.dart';
import 'package:badabhai_worker_app/features/chat/presentation/bloc/chat_bloc.dart';
import 'package:badabhai_worker_app/features/chat/presentation/chat_profiling_screen.dart';

/// ── THE RÉSUMÉ CONFIRM AS THE SESSION'S FIRST TURN (#1523) ──────────────────
///
/// `POST /chat/session` with `confirm_first: true` can return `resume_pending: true`
/// with an `opening_text` ("Resume se ye mila: … Sahi hai?") and Haan/Nahi
/// `opening_options`. The client must:
///
///   1. suppress the canned `kChatOpeningText` and render the server's confirm as
///      bubble 0, with its chips as `suggestedOptions` on the first turn;
///   2. never let the worker see "aap kaunsa kaam karte hain?" on that session;
///   3. submit the chip's LABEL (the answer of record) while carrying its
///      `option_key` for lookahead — exactly a later-turn suggested-options tap;
///   4. parse nothing locally — the server's `opening_text` is the only source.
class MockChatRepository extends Mock implements ChatRepository {}

const String _confirm = 'Resume se ye mila: CNC Turner · Pune. Sahi hai?';
const List<ChatOption> _confirmOptions = <ChatOption>[
  ChatOption(optionKey: 'resume_confirm_yes', labelText: 'Haan, sahi hai'),
  ChatOption(optionKey: 'resume_confirm_no', labelText: 'Nahi'),
];

SessionRepository _authed() => SessionRepository()
  ..setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: 'tok');

void main() {
  // --- 1. the model ---------------------------------------------------------

  group('ChatSessionStart resume_pending (#1523)', () {
    test('carries resume_pending + opening_options', () {
      final ChatSessionStart start = ChatSessionStart.fromJson(<String, dynamic>{
        'session_id': 's1',
        'opening_text': _confirm,
        'resume_pending': true,
        'opening_options': <Map<String, dynamic>>[
          <String, dynamic>{
            'option_key': 'resume_confirm_yes',
            'label_text': 'Haan, sahi hai',
          },
          <String, dynamic>{
            'option_key': 'resume_confirm_no',
            'label_text': 'Nahi',
          },
        ],
      });

      expect(start.openingText, _confirm);
      expect(start.resumePending, isTrue);
      expect(start.openingOptions.map((ChatOption o) => o.optionKey),
          <String>['resume_confirm_yes', 'resume_confirm_no']);
    });

    test('an absent resume_pending reads false — an older/ordinary opener', () {
      final ChatSessionStart start = ChatSessionStart.fromJson(
          <String, dynamic>{'session_id': 's1', 'opening_text': 'Namaste.'});
      expect(start.resumePending, isFalse);
      expect(start.openingOptions, isEmpty);
    });
  });

  // --- 2. the repository seam ----------------------------------------------

  test('ensureSession builds a resumePending opening from the API response',
      () async {
    final ChatRepositoryImpl repo = ChatRepositoryImpl(
      ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async {
          if (req.url.path == '/chat/session/latest') {
            return http.Response(
                jsonEncode(<String, dynamic>{'session_id': null}), 200);
          }
          // UTF-8 bytes: the confirm can carry Devanagari / a middot.
          return http.Response.bytes(
            utf8.encode(jsonEncode(<String, dynamic>{
              'session_id': 's1',
              'opening_text': _confirm,
              'resume_pending': true,
              'opening_options': <Map<String, dynamic>>[
                <String, dynamic>{
                  'option_key': 'resume_confirm_yes',
                  'label_text': 'Haan, sahi hai',
                },
                <String, dynamic>{
                  'option_key': 'resume_confirm_no',
                  'label_text': 'Nahi',
                },
              ],
            })),
            201,
            headers: <String, String>{
              'content-type': 'application/json; charset=utf-8',
            },
          );
        }),
      ),
      _authed(),
    );

    final ChatSessionOpening? opening = await repo.ensureSession();

    expect(opening, isNotNull);
    expect(opening!.text, _confirm);
    expect(opening.resumePending, isTrue);
    expect(opening.options, _confirmOptions);
    // No local parsing: the confirm is exactly the server's text, byte-for-byte.
    expect(opening.text, _confirm);
  });

  // --- 3. the bloc ----------------------------------------------------------

  group('ChatBloc resume-confirm opening (#1523)', () {
    late MockChatRepository repo;
    setUp(() {
      repo = MockChatRepository();
      when(() => repo.loadHistory())
          .thenAnswer((_) async => const <ChatMessage>[]);
    });

    blocTest<ChatBloc, ChatState>(
      'renders the confirm as bubble 0 with chips — the canned opener is gone',
      build: () {
        when(() => repo.ensureSession()).thenAnswer((_) async =>
            const ChatSessionOpening(
              text: _confirm,
              resumePending: true,
              options: _confirmOptions,
            ));
        return ChatBloc(repo);
      },
      act: (ChatBloc b) => b.add(const ChatStarted()),
      expect: () => const <ChatState>[
        ChatState(
          messages: <ChatMessage>[ChatMessage(text: _confirm, fromWorker: false)],
          initializing: false,
          resumePending: true,
          suggestedOptions: _confirmOptions,
          followups: <String>['Haan, sahi hai', 'Nahi'],
        ),
      ],
      verify: (ChatBloc b) {
        final ChatMessage first = b.state.messages.first;
        expect(first.text, _confirm);
        expect(first.text, isNot(kChatOpeningText),
            reason: 'the worker must NEVER see the canned opener here');
        // The options carry their stable keys, so the first chip tap indexes the
        // turn exactly like a later suggested-options tap (#761).
        expect(
          b.state.suggestedOptions.map((ChatOption o) => o.optionKey),
          <String>['resume_confirm_yes', 'resume_confirm_no'],
        );
      },
    );

    blocTest<ChatBloc, ChatState>(
      'a failed resume-confirm open keeps the canned fallback',
      build: () {
        when(() => repo.ensureSession()).thenAnswer((_) async => null);
        return ChatBloc(repo);
      },
      act: (ChatBloc b) => b.add(const ChatStarted()),
      expect: () => const <ChatState>[
        ChatState(
          messages: <ChatMessage>[kChatOpeningMessage],
          initializing: false,
        ),
      ],
      verify: (ChatBloc b) {
        expect(b.state.resumePending, isFalse);
      },
    );
  });

  // --- 4. the screen: first-turn chips submit the label of record -----------

  group('ChatProfilingScreen resume confirm (#1523)', () {
    late MockChatRepository repo;

    setUp(() async {
      repo = MockChatRepository();
      await locator.reset();
      locator.registerFactory<ChatBloc>(() => ChatBloc(repo));
      when(() => repo.loadHistory())
          .thenAnswer((_) async => const <ChatMessage>[]);
      when(() => repo.ensureSession()).thenAnswer((_) async =>
          const ChatSessionOpening(
            text: _confirm,
            resumePending: true,
            options: _confirmOptions,
          ));
      registerFallbackValue(const ChatTurn(reply: ''));
    });

    tearDown(() async => locator.reset());

    testWidgets('shows the confirm + Haan/Nahi chips, never the canned opener',
        (WidgetTester tester) async {
      tester.view.physicalSize = const Size(400, 700);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      await tester.pumpWidget(const MaterialApp(home: ChatProfilingScreen()));
      await tester.pump();
      await tester.pumpAndSettle();

      expect(find.text(_confirm), findsOneWidget);
      expect(find.text('Haan, sahi hai'), findsOneWidget);
      expect(find.text('Nahi'), findsOneWidget);
      expect(find.textContaining('aap kaun sa kaam karte hain'), findsNothing,
          reason: 'a resume-routed session must never show the canned opener');
      expect(find.text(kChatOpeningText), findsNothing);
    });

    testWidgets('tapping a chip submits its label as the first message',
        (WidgetTester tester) async {
      when(() => repo.sendMessage(any(),
              submissionId: any(named: 'submissionId')))
          .thenAnswer((_) async => const ChatTurn(reply: 'Theek hai.'));

      tester.view.physicalSize = const Size(400, 700);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      await tester.pumpWidget(const MaterialApp(home: ChatProfilingScreen()));
      await tester.pump();
      await tester.pumpAndSettle();

      await tester.tap(find.text('Haan, sahi hai'));
      await tester.pumpAndSettle();

      // The LABEL is the answer of record; the option_key rode along for
      // lookahead exactly as a later suggested-options tap (#761).
      verify(() => repo.sendMessage('Haan, sahi hai',
          submissionId: any(named: 'submissionId'))).called(1);
      expect(find.text('Theek hai.'), findsOneWidget);
    });
  });
}
