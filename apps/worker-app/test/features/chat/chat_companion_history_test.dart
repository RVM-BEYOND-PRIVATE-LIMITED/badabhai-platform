import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/session/resume_download_offer_store.dart';
import 'package:badabhai_worker_app/core/session/session_repository.dart';
import 'package:badabhai_worker_app/features/chat/data/chat_repository_impl.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_message.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_repository.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_turn.dart';
import 'package:badabhai_worker_app/features/chat/presentation/bloc/chat_bloc.dart';
import 'package:badabhai_worker_app/features/resume/domain/resume_repository.dart';

class _MockChatRepository extends Mock implements ChatRepository {}

class _MockResumeRepository extends Mock implements ResumeRepository {}

const String _recap = 'Namaste. Aapki profile taiyaar hai.';

Map<String, dynamic> _option(String key, String label) => <String, dynamic>{
  'option_key': key,
  'label_text': label,
  'is_none_of_above': false,
};

/// `GET /chat/companion` with a 7-day `history` (contract #2297).
Map<String, dynamic> _openJson({List<Object?>? history}) => <String, dynamic>{
  'mode': 'companion',
  'digest_key': 'k1',
  'reply': _recap,
  'tts_text': 'नमस्ते।',
  'blocked': false,
  'is_mock': false,
  'suggested_followups': <String>['Sabhi jobs dekhein'],
  'suggested_options': <Map<String, dynamic>>[
    _option('companion_jobs_tab', 'Sabhi jobs dekhein'),
  ],
  'question_kind': 'disambiguate',
  'history': ?history,
};

/// Three days of chat: the stored recap, a question, a model answer with news,
/// and the last Bada Bhai line with its chips.
final List<Object?> _week = <Object?>[
  <String, dynamic>{
    'id': '11111111-1111-4111-8111-111111111111',
    'role': 'bada_bhai',
    'text': 'Namaste. Aapki profile taiyaar hai.',
    'tts_text': 'नमस्ते।',
    'suggested_options': <Map<String, dynamic>>[
      _option('companion_old', 'Purana chip'),
    ],
    'suggested_followups': <String>['Purana chip'],
    'created_at': '2026-10-12T09:00:00.000Z',
  },
  <String, dynamic>{
    'id': '22222222-2222-4222-8222-222222222222',
    'role': 'worker',
    'text': 'CNC ki naukri Pune mein?',
    'created_at': '2026-10-12T09:01:00.000Z',
  },
  <String, dynamic>{
    'id': '33333333-3333-4333-8333-333333333333',
    'role': 'bada_bhai',
    'text': 'Pune mein CNC ki 3 naukriyan hain.',
    'read_aloud': false,
    'news_links': <Map<String, dynamic>>[
      <String, dynamic>{
        'title': 'Pune hiring',
        'url': 'https://example.com/a',
        'site': 'example.com',
      },
    ],
    'created_at': '2026-10-12T09:01:05.000Z',
  },
  <String, dynamic>{
    'id': '44444444-4444-4444-8444-444444444444',
    'role': 'worker',
    'text': 'Theek hai',
    'created_at': '2026-10-14T18:00:00.000Z',
  },
  <String, dynamic>{
    'id': '55555555-5555-4555-8555-555555555555',
    'role': 'bada_bhai',
    'text': 'Aur kuch poochna hai?',
    'suggested_options': <Map<String, dynamic>>[
      _option('companion_jobs_tab', 'Sabhi jobs dekhein'),
      _option('companion_resume', 'Resume badlein'),
    ],
    'suggested_followups': <String>['Sabhi jobs dekhein', 'Resume badlein'],
    'created_at': '2026-10-14T18:00:03.000Z',
  },
];

http.Response _json(Object body) => http.Response(
  jsonEncode(body),
  200,
  headers: <String, String>{'content-type': 'application/json; charset=utf-8'},
);

ChatRepositoryImpl _repoServing(Map<String, dynamic> body) => ChatRepositoryImpl(
  ApiClient(
    baseUrl: 'http://test',
    client: MockClient((http.Request req) async => _json(body)),
  ),
  SessionRepository()
    ..setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: 'tok'),
);

ChatTurn _recapTurn({String digestKey = 'k1'}) => ChatTurn(
  reply: _recap,
  followups: const <String>['Sabhi jobs dekhein'],
  suggestedOptions: const <ChatOption>[
    ChatOption(optionKey: 'companion_jobs_tab', labelText: 'Sabhi jobs dekhein'),
  ],
  questionKind: ChatQuestionKind.disambiguate,
  companion: true,
  digestKey: digestKey,
);

/// #2298 — the Bada Bhai chat draws its last 7 days on open and cold reopen.
void main() {
  group('reading history (repository)', () {
    test('bubbles keep their roles and the live-turn rules; chips come from the LAST Bada Bhai message', () async {
      final CompanionOpening opening =
          await _repoServing(_openJson(history: _week)).openCompanion();

      final CompanionHistory history = opening.history!;
      expect(history.messages.map((ChatMessage m) => m.text).toList(), <String>[
        'Namaste. Aapki profile taiyaar hai.',
        'CNC ki naukri Pune mein?',
        'Pune mein CNC ki 3 naukriyan hain.',
        'Theek hai',
        'Aur kuch poochna hai?',
      ]);
      expect(
        history.messages.map((ChatMessage m) => m.fromWorker).toList(),
        <bool>[false, true, false, true, false],
      );
      // A fixed line keeps its speaker and its Devanagari twin.
      expect(history.messages[0].ttsText, 'नमस्ते।');
      expect(history.messages[0].canReadAloud, isTrue);
      // A model-written line: no speaker, plain prose, its news tiles.
      expect(history.messages[2].canReadAloud, isFalse);
      expect(history.messages[2].bulleted, isFalse);
      expect(history.messages[2].newsLinks.single.title, 'Pune hiring');
      // Only the last Bada Bhai message's chips; the old one's are gone.
      expect(
        history.suggestedOptions.map((ChatOption o) => o.optionKey).toList(),
        <String>['companion_jobs_tab', 'companion_resume'],
      );
      expect(history.followups, <String>['Sabhi jobs dekhein', 'Resume badlein']);
      // The recap is still read, for its digest and turn fields.
      expect(opening.turn!.reply, _recap);
    });

    test('absent, empty or unusable history means NO history — the recap is drawn', () async {
      for (final Map<String, dynamic> body in <Map<String, dynamic>>[
        _openJson(),
        _openJson(history: const <Object?>[]),
        _openJson(
          history: <Object?>[
            null,
            42,
            <String, dynamic>{'role': 'system', 'text': 'x'},
            <String, dynamic>{'role': 'worker', 'text': '   '},
          ],
        ),
        <String, dynamic>{..._openJson(), 'history': 'not a list'},
      ]) {
        final CompanionOpening opening = await _repoServing(body).openCompanion();
        expect(opening.isCompanion, isTrue);
        expect(opening.history, isNull, reason: '${body['history']}');
      }
    });

    test('one bad entry is dropped, the rest of the history survives', () async {
      final CompanionOpening opening = await _repoServing(
        _openJson(history: <Object?>[..._week, <String, dynamic>{'role': 1}]),
      ).openCompanion();
      expect(opening.history!.messages, hasLength(5));
    });
  });

  group('drawing history (bloc)', () {
    late _MockChatRepository repo;
    late DateTime now;

    final CompanionHistory history = CompanionHistory(
      messages: const <ChatMessage>[
        ChatMessage(text: 'Namaste. Aapki profile taiyaar hai.', fromWorker: false),
        ChatMessage(text: 'CNC ki naukri Pune mein?', fromWorker: true),
        ChatMessage(text: 'Aur kuch poochna hai?', fromWorker: false),
      ],
      followups: const <String>['Resume badlein'],
      suggestedOptions: const <ChatOption>[
        ChatOption(optionKey: 'companion_resume', labelText: 'Resume badlein'),
      ],
    );

    List<String> texts(ChatBloc b) =>
        b.state.messages.map((ChatMessage m) => m.text).toList();

    void serverSays(CompanionOpening opening) =>
        when(() => repo.openCompanion()).thenAnswer((_) async => opening);

    setUp(() {
      repo = _MockChatRepository();
      now = DateTime.utc(2026, 10, 15, 10);
      when(() => repo.loadHistory()).thenAnswer((_) async => const <ChatMessage>[]);
      when(() => repo.ensureSession()).thenAnswer((_) async => null);
    });

    ChatBloc bloc0() => ChatBloc(repo, clock: () => now);

    test('history is drawn INSTEAD of the recap — no new recap bubble', () async {
      serverSays(CompanionOpening(CompanionOpenOutcome.companion, _recapTurn(), history));
      final ChatBloc bloc = bloc0()..add(const ChatCompanionStarted());
      await pumpEventQueue();

      expect(bloc.state.companion, isTrue);
      expect(bloc.state.initializing, isFalse);
      expect(texts(bloc), <String>[
        'Namaste. Aapki profile taiyaar hai.',
        'CNC ki naukri Pune mein?',
        'Aur kuch poochna hai?',
      ]);
      verifyNever(() => repo.ensureSession());
      await bloc.close();
    });

    test('chips are ONLY the last Bada Bhai message\'s, never the recap\'s', () async {
      serverSays(CompanionOpening(CompanionOpenOutcome.companion, _recapTurn(), history));
      final ChatBloc bloc = bloc0()..add(const ChatCompanionStarted());
      await pumpEventQueue();

      expect(
        bloc.state.suggestedOptions.map((ChatOption o) => o.optionKey).toList(),
        <String>['companion_resume'],
      );
      expect(bloc.state.followups, <String>['Resume badlein']);
      await bloc.close();
    });

    test('no history: the recap opens the chat exactly as before', () async {
      serverSays(CompanionOpening(CompanionOpenOutcome.companion, _recapTurn()));
      final ChatBloc bloc = bloc0()..add(const ChatCompanionStarted());
      await pumpEventQueue();

      expect(texts(bloc), <String>[_recap]);
      expect(
        bloc.state.suggestedOptions.map((ChatOption o) => o.optionKey).toList(),
        <String>['companion_jobs_tab'],
      );
      await bloc.close();
    });

    test('a refocus keeps the drawn history — no wipe, no duplicate', () async {
      serverSays(CompanionOpening(CompanionOpenOutcome.companion, _recapTurn(), history));
      final ChatBloc bloc = bloc0()..add(const ChatCompanionStarted());
      await pumpEventQueue();
      final List<String> drawn = texts(bloc);

      now = now.add(const Duration(minutes: 5));
      bloc.add(const ChatCompanionRefreshRequested());
      await pumpEventQueue();
      bloc.add(const ChatCompanionRefreshRequested(force: true));
      await pumpEventQueue();

      expect(texts(bloc), drawn);
      verify(() => repo.openCompanion()).called(3);
      await bloc.close();
    });

    test('a refocus whose facts CHANGED appends the new recap below the history', () async {
      serverSays(CompanionOpening(CompanionOpenOutcome.companion, _recapTurn(), history));
      final ChatBloc bloc = bloc0()..add(const ChatCompanionStarted());
      await pumpEventQueue();
      final List<String> drawn = texts(bloc);

      serverSays(
        CompanionOpening(
          CompanionOpenOutcome.companion,
          _recapTurn(digestKey: 'k2'),
          history,
        ),
      );
      now = now.add(const Duration(minutes: 5));
      bloc.add(const ChatCompanionRefreshRequested());
      await pumpEventQueue();

      expect(texts(bloc), <String>[...drawn, _recap]);
      await bloc.close();
    });

    test('a tab that opened on the interview moves to the HISTORY on refocus', () async {
      serverSays(const CompanionOpening.interview());
      when(() => repo.forgetSession()).thenReturn(null);
      final ChatBloc bloc = bloc0()..add(const ChatCompanionStarted());
      await pumpEventQueue();
      expect(bloc.state.companion, isFalse);

      serverSays(CompanionOpening(CompanionOpenOutcome.companion, _recapTurn(), history));
      now = now.add(const Duration(seconds: 5));
      bloc.add(const ChatCompanionRefreshRequested());
      await pumpEventQueue();

      expect(bloc.state.companion, isTrue);
      expect(texts(bloc), <String>[
        'Namaste. Aapki profile taiyaar hai.',
        'CNC ki naukri Pune mein?',
        'Aur kuch poochna hai?',
      ]);
      expect(
        bloc.state.suggestedOptions.map((ChatOption o) => o.optionKey).toList(),
        <String>['companion_resume'],
      );
      await bloc.close();
    });

    test('the "Resume download" tile is offered below the history, as today', () async {
      final _MockResumeRepository resumes = _MockResumeRepository();
      when(() => resumes.loadResumeHistory()).thenAnswer(
        (_) async => ResumeHistory(
          items: <ResumeHistoryItem>[
            ResumeHistoryItem(
              resumeId: '66666666-6666-4666-8666-666666666666',
              renderStatus: 'rendered',
              isCurrent: true,
              generatedAt: DateTime.utc(2026, 10, 14),
            ),
          ],
        ),
      );
      serverSays(CompanionOpening(CompanionOpenOutcome.companion, _recapTurn(), history));
      final ChatBloc bloc = ChatBloc(
        repo,
        clock: () => now,
        resumeRepository: resumes,
        resumeDownloadOffers: InMemoryResumeDownloadOfferStore(),
      )
        ..add(const ChatCompanionStarted())
        ..add(const ChatResumeDownloadOffered());
      await pumpEventQueue();

      expect(bloc.state.resumeDownloadTile, isTrue);
      expect(texts(bloc), hasLength(3));
      await bloc.close();
    });
  });
}
