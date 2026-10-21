import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/config/remote_config.dart';
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/session/session_repository.dart';
import 'package:badabhai_worker_app/features/chat/data/chat_repository_impl.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_message.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_repository.dart';
import 'package:badabhai_worker_app/features/chat/presentation/bloc/chat_bloc.dart';
import 'package:badabhai_worker_app/features/chat/presentation/chat_profiling_screen.dart';
import 'package:badabhai_worker_app/features/chat/presentation/widgets/chat_end_divider.dart';

class _MockChatRepository extends Mock implements ChatRepository {}

const String _recap = 'Namaste. Aapki profile taiyaar hai.';

Map<String, dynamic> _option(String key, String label) => <String, dynamic>{
  'option_key': key,
  'label_text': label,
  'is_none_of_above': false,
};

/// One `conversation.messages[]` line (contract #2392 / ADR-0059).
Map<String, dynamic> _line(
  String source,
  String role,
  String text, {
  String? tts,
  bool? readAloud,
  bool ends = false,
  int minute = 0,
}) => <String, dynamic>{
  'id': '00000000-0000-4000-8000-${minute.toString().padLeft(12, '0')}',
  'source': source,
  'role': role,
  'text': text,
  'tts_text': ?tts,
  'read_aloud': ?readAloud,
  if (ends) 'ends_profiling_chat': true,
  'created_at': '2026-10-21T09:${minute.toString().padLeft(2, '0')}:00.000Z',
};

/// Two profiling chats (the first finished, then a redo), a Bada Bhai chat
/// exchange between them, and the conversation's own chips.
final Map<String, dynamic> _conversation = <String, dynamic>{
  'messages': <Object?>[
    _line(
      'profiling',
      'bada_bhai',
      'Aap kaun sa kaam karte hain?',
      tts: 'आप कौन सा काम करते हैं?',
      minute: 1,
    ),
    _line('profiling', 'worker', 'Plumber', minute: 2),
    _line(
      'profiling',
      'bada_bhai',
      'Aapki baat poori ho chuki hai.',
      ends: true,
      minute: 3,
    ),
    _line('bada_bhai_chat', 'worker', 'Pune mein naukri?', minute: 4),
    _line(
      'bada_bhai_chat',
      'bada_bhai',
      'Pune mein 3 naukriyan hain.',
      readAloud: false,
      minute: 5,
    ),
    _line('profiling', 'bada_bhai', 'Phir se shuru karte hain.', minute: 6),
    _line('profiling', 'worker', 'Pipe fitting', ends: true, minute: 7),
  ],
  'suggested_options': <Map<String, dynamic>>[
    _option('companion_jobs_tab', 'Sabhi jobs dekhein'),
    _option('companion_resume', 'Resume badlein'),
  ],
  'suggested_followups': <String>['Sabhi jobs dekhein', 'Resume badlein'],
};

Map<String, dynamic> _openJson({
  Object? conversation,
  List<Object?>? history,
}) => <String, dynamic>{
  'mode': 'companion',
  'digest_key': 'k1',
  'reply': _recap,
  'blocked': false,
  'is_mock': false,
  'suggested_followups': <String>['Recap chip'],
  'suggested_options': <Map<String, dynamic>>[
    _option('companion_recap', 'Recap chip'),
  ],
  'question_kind': 'disambiguate',
  'history': ?history,
  'conversation': ?conversation,
};

ChatRepositoryImpl _repoServing(Map<String, dynamic> body) =>
    ChatRepositoryImpl(
      ApiClient(
        baseUrl: 'http://test',
        client: MockClient(
          (http.Request req) async => http.Response(
            jsonEncode(body),
            200,
            headers: <String, String>{
              'content-type': 'application/json; charset=utf-8',
            },
          ),
        ),
      ),
      SessionRepository()..setWorker(
        phone: '+910000000000',
        workerId: 'w1',
        sessionToken: 'tok',
      ),
    );

/// #2392 — the Bada Bhai chat draws the profiling conversation of the last 7
/// days, each profiling chat closed by its own divider; the recap only when
/// there is nothing to show.
void main() {
  group('parsing `conversation` (repository)', () {
    test('lines keep their roles and source rules; chips are the '
        'conversation\'s own; every profiling chat is closed', () async {
      final CompanionOpening opening = await _repoServing(
        _openJson(conversation: _conversation),
      ).openCompanion();

      final CompanionHistory drawn = opening.history!;
      expect(drawn.messages.map((ChatMessage m) => m.text).toList(), <String>[
        'Aap kaun sa kaam karte hain?',
        'Plumber',
        'Aapki baat poori ho chuki hai.',
        'Pune mein naukri?',
        'Pune mein 3 naukriyan hain.',
        'Phir se shuru karte hain.',
        'Pipe fitting',
      ]);
      expect(
        drawn.messages.map((ChatMessage m) => m.fromWorker).toList(),
        <bool>[false, true, false, true, false, false, true],
      );
      // Profiling line: as the interview redraw — speaker with its twin,
      // no bullets.
      expect(drawn.messages[0].ttsText, 'आप कौन सा काम करते हैं?');
      expect(drawn.messages[0].canReadAloud, isTrue);
      expect(drawn.messages[0].bulleted, isFalse);
      // Bada Bhai chat line, model-written: no speaker, plain prose.
      expect(drawn.messages[4].canReadAloud, isFalse);
      expect(drawn.messages[4].bulleted, isFalse);
      // One divider per profiling chat.
      expect(
        <int>[
          for (int i = 0; i < drawn.messages.length; i++)
            if (drawn.messages[i].closesSession) i,
        ],
        <int>[2, 6],
      );
      expect(
        drawn.suggestedOptions.map((ChatOption o) => o.optionKey).toList(),
        <String>['companion_jobs_tab', 'companion_resume'],
      );
      expect(drawn.followups, <String>['Sabhi jobs dekhein', 'Resume badlein']);
    });

    test('`conversation` wins over `history`', () async {
      final CompanionOpening opening = await _repoServing(
        _openJson(
          conversation: _conversation,
          history: <Object?>[
            <String, dynamic>{'role': 'bada_bhai', 'text': 'Old history line'},
          ],
        ),
      ).openCompanion();
      expect(
        opening.history!.messages.first.text,
        'Aap kaun sa kaam karte hain?',
      );
    });

    test('absent, empty or malformed `conversation` reads as absent — '
        '`history`, then the recap, as before', () async {
      for (final Object? bad in <Object?>[
        null,
        'not a map',
        <String, dynamic>{'messages': 'not a list'},
        <String, dynamic>{'messages': <Object?>[]},
        <String, dynamic>{
          'messages': <Object?>[
            null,
            42,
            <String, dynamic>{'source': 'x', 'role': 'worker', 'text': 'a'},
            <String, dynamic>{
              'source': 'profiling',
              'role': 'system',
              'text': 'a',
            },
            <String, dynamic>{
              'source': 'profiling',
              'role': 'worker',
              'text': '  ',
            },
          ],
        },
      ]) {
        final CompanionOpening noHistory = await _repoServing(
          _openJson(conversation: bad),
        ).openCompanion();
        expect(noHistory.isCompanion, isTrue);
        expect(noHistory.history, isNull, reason: '$bad');

        final CompanionOpening withHistory = await _repoServing(
          _openJson(
            conversation: bad,
            history: <Object?>[
              <String, dynamic>{'role': 'bada_bhai', 'text': 'History line'},
            ],
          ),
        ).openCompanion();
        expect(
          withHistory.history!.messages.single.text,
          'History line',
          reason: '$bad',
        );
      }
    });

    test('a malformed line is dropped on its own', () async {
      final CompanionOpening opening = await _repoServing(
        _openJson(
          conversation: <String, dynamic>{
            ..._conversation,
            'messages': <Object?>[
              ...(_conversation['messages'] as List<Object?>),
              <String, dynamic>{'role': 1},
            ],
          },
        ),
      ).openCompanion();
      expect(opening.history!.messages, hasLength(7));
    });
  });

  group('drawing `conversation` (bloc)', () {
    List<String> texts(ChatBloc b) =>
        b.state.messages.map((ChatMessage m) => m.text).toList();

    test('the open draws the conversation INSTEAD of the recap, with its '
        'chips and every divider flag', () async {
      final ChatBloc bloc = ChatBloc(
        _repoServing(_openJson(conversation: _conversation)),
      )..add(const ChatCompanionStarted());
      await pumpEventQueue();

      expect(bloc.state.companion, isTrue);
      expect(texts(bloc), isNot(contains(_recap)));
      expect(texts(bloc), hasLength(7));
      expect(
        bloc.state.messages.where((ChatMessage m) => m.closesSession),
        hasLength(2),
      );
      expect(
        bloc.state.suggestedOptions.map((ChatOption o) => o.optionKey).toList(),
        <String>['companion_jobs_tab', 'companion_resume'],
      );
      await bloc.close();
    });

    test('no conversation and no history: the recap, as before', () async {
      final ChatBloc bloc = ChatBloc(_repoServing(_openJson()))
        ..add(const ChatCompanionStarted());
      await pumpEventQueue();
      expect(texts(bloc), <String>[_recap]);
      await bloc.close();
    });

    test('a tab that opened on the interview moves to the CONVERSATION on '
        'refocus', () async {
      final _MockChatRepository repo = _MockChatRepository();
      DateTime now = DateTime.utc(2026, 10, 21, 10);
      when(
        () => repo.loadHistory(),
      ).thenAnswer((_) async => const <ChatMessage>[]);
      when(() => repo.ensureSession()).thenAnswer((_) async => null);
      when(() => repo.forgetSession()).thenReturn(null);
      when(
        () => repo.openCompanion(),
      ).thenAnswer((_) async => const CompanionOpening.interview());
      final ChatBloc bloc = ChatBloc(repo, clock: () => now)
        ..add(const ChatCompanionStarted());
      await pumpEventQueue();
      expect(bloc.state.companion, isFalse);

      final CompanionOpening served = await _repoServing(
        _openJson(conversation: _conversation),
      ).openCompanion();
      when(() => repo.openCompanion()).thenAnswer((_) async => served);
      now = now.add(const Duration(seconds: 5));
      bloc.add(const ChatCompanionRefreshRequested());
      await pumpEventQueue();

      expect(bloc.state.companion, isTrue);
      expect(texts(bloc), hasLength(7));
      expect(
        bloc.state.messages.where((ChatMessage m) => m.closesSession),
        hasLength(2),
      );
      await bloc.close();
    });
  });

  group('drawing `conversation` (screen)', () {
    setUp(() async {
      await locator.reset();
      BbRemoteConfig.instance.debugSetSnapshot(<String, Object>{
        BbRemoteConfig.kKeyChatCompanionEnabled: true,
      });
    });

    tearDown(() async {
      BbRemoteConfig.instance.debugReset();
      await locator.reset();
    });

    testWidgets('one "End of conversation" divider after EACH profiling chat', (
      WidgetTester tester,
    ) async {
      tester.view.physicalSize = const Size(500, 2400);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final ChatRepository repo = _repoServing(
        _openJson(conversation: _conversation),
      );
      locator.registerFactory<ChatBloc>(() => ChatBloc(repo));
      await tester.pumpWidget(
        MaterialApp.router(
          routerConfig: GoRouter(
            initialLocation: '/bada-bhai',
            routes: <RouteBase>[
              GoRoute(
                path: '/bada-bhai',
                builder: (_, __) =>
                    const ChatProfilingScreen(assistantTab: true),
              ),
            ],
          ),
        ),
      );
      await tester.pump();
      await tester.pumpAndSettle();

      expect(find.byType(ChatEndDivider), findsNWidgets(2));
      expect(find.text('Aapki baat poori ho chuki hai.'), findsOneWidget);
      expect(find.text('Pipe fitting'), findsOneWidget);
      expect(find.text(_recap), findsNothing);
      expect(find.text('Resume badlein'), findsOneWidget);
      // Dividers sit right AFTER their closing lines.
      final double firstClose = tester
          .getTopLeft(find.text('Aapki baat poori ho chuki hai.'))
          .dy;
      final double nextLine = tester
          .getTopLeft(find.text('Pune mein naukri?'))
          .dy;
      final double firstDivider = tester
          .getTopLeft(find.byType(ChatEndDivider).first)
          .dy;
      final double lastDivider = tester
          .getTopLeft(find.byType(ChatEndDivider).last)
          .dy;
      expect(firstDivider, greaterThan(firstClose));
      expect(firstDivider, lessThan(nextLine));
      expect(
        lastDivider,
        greaterThan(tester.getTopLeft(find.text('Pipe fitting')).dy),
      );
    });
  });
}
