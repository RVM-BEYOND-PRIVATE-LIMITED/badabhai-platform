import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/session/session_repository.dart';
import 'package:badabhai_worker_app/features/chat/data/chat_repository_impl.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_message.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_turn.dart';

/// A client that fails the test if it is ever hit — the fail-closed guards must
/// short-circuit before any network call.
MockClient _neverCalled() =>
    MockClient((http.Request req) async => fail('network must not be hit'));

ChatRepositoryImpl _repo(SessionRepository session) {
  return ChatRepositoryImpl(
    ApiClient(baseUrl: 'http://test', client: _neverCalled()),
    session,
  );
}

void main() {
  test('ensureSession fails closed with UnauthorizedFailure when no token', () {
    final ChatRepositoryImpl repo = _repo(SessionRepository());
    expect(repo.ensureSession(), throwsA(isA<UnauthorizedFailure>()));
  });

  test('sendMessage fails closed with UnauthorizedFailure when no token', () {
    final ChatRepositoryImpl repo = _repo(SessionRepository());
    expect(repo.sendMessage('hi'), throwsA(isA<UnauthorizedFailure>()));
  });

  // #343 — this previously asserted that a token-holding worker with no open
  // session got UnauthorizedFailure FOREVER. That "fail closed" was the defect,
  // not a safeguard: one failed session-open (routine on 2G) silently discarded
  // every later answer. The authenticated worker must self-heal instead. The
  // genuine fail-closed guards — no token, no send — are the two tests above and
  // still hold.
  group('lazy session self-heal (#343)', () {
    test('sendMessage opens the session when one was never opened, then sends',
        () async {
      final SessionRepository session = SessionRepository()
        ..setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: 'tok');

      final List<String> hitPaths = <String>[];
      final ChatRepositoryImpl repo = ChatRepositoryImpl(
        ApiClient(
          baseUrl: 'http://test',
          client: MockClient((http.Request req) async {
            hitPaths.add(req.url.path);
            // No prior session to resume (brand-new worker) → the open path runs.
            if (req.url.path == '/chat/session/latest') {
              return http.Response(
                  jsonEncode(<String, dynamic>{'session_id': null}), 200);
            }
            if (req.url.path == '/chat/session') {
              return http.Response(
                  jsonEncode(<String, dynamic>{'session_id': 's1'}), 201);
            }
            return http.Response(
                jsonEncode(<String, dynamic>{'reply': 'Got it.'}), 200);
          }),
        ),
        session,
      );

      final ChatTurn turn = await repo.sendMessage('hi');

      expect(turn.reply, 'Got it.');
      expect(session.sessionId, 's1', reason: 'the session healed itself');
      expect(
          hitPaths,
          <String>['/chat/session/latest', '/chat/session', '/chat/message'],
          reason: 'resume-check (none), then session-open, then the send');
    });

    test('resumes the worker\'s latest session instead of opening a new one',
        () async {
      final SessionRepository session = SessionRepository()
        ..setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: 'tok');

      final List<String> hitPaths = <String>[];
      final ChatRepositoryImpl repo = ChatRepositoryImpl(
        ApiClient(
          baseUrl: 'http://test',
          client: MockClient((http.Request req) async {
            hitPaths.add(req.url.path);
            if (req.url.path == '/chat/session/latest') {
              return http.Response(
                  jsonEncode(<String, dynamic>{'session_id': 'prior-1'}), 200);
            }
            return http.Response(
                jsonEncode(<String, dynamic>{'reply': 'Got it.'}), 200);
          }),
        ),
        session,
      );

      final String? opener = await repo.ensureSession();

      // Re-attached to the signup session (so loadHistory redraws its Q&A) — a
      // resume serves NO opener, and it must NOT mint a fresh /chat/session.
      expect(opener, isNull);
      expect(session.sessionId, 'prior-1',
          reason: 'the Bada Bhai tab resumes the existing session');
      expect(hitPaths, <String>['/chat/session/latest'],
          reason: 'latest found → resume, no new session-open');
    });

    test('a still-failing session-open surfaces the failure (never silence)',
        () async {
      final SessionRepository session = SessionRepository()
        ..setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: 'tok');
      final ChatRepositoryImpl repo = ChatRepositoryImpl(
        ApiClient(
          baseUrl: 'http://test',
          client: MockClient(
              (http.Request req) async => throw const SocketException('down')),
        ),
        session,
      );

      // A Failure — NOT a silently-swallowed no-op: the bloc marks the bubble
      // failed and offers retry on the back of this throw.
      await expectLater(repo.sendMessage('hi'), throwsA(isA<Failure>()));
    });
  });

  // #1198 — resume is best-effort but must NOT be silent: a failed
  // GET /chat/session/latest is retried ONCE, then (if it still fails) mapped +
  // logged as a non-fatal and fallen-through to opening a new session. A fast
  // double entry must not mint two sessions. And an old-build POST that returns
  // the worker's EXISTING session (no opening_text) must keep the canned greeting.
  group('resume hardening (#1198)', () {
    test('a failing /latest is retried once, logged (not swallowed), then falls '
        'through to open a new session', () async {
      final SessionRepository session = SessionRepository()
        ..setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: 'tok');

      final List<String> hitPaths = <String>[];
      int latestHits = 0;
      final List<Object> loggedErrors = <Object>[];
      final List<String> loggedReasons = <String>[];

      final ChatRepositoryImpl repo = ChatRepositoryImpl(
        ApiClient(
          baseUrl: 'http://test',
          client: MockClient((http.Request req) async {
            hitPaths.add(req.url.path);
            if (req.url.path == '/chat/session/latest') {
              latestHits++;
              // Both attempts time out (2G) — the whole point of #1198.
              throw const SocketException('2G timeout');
            }
            if (req.url.path == '/chat/session') {
              return http.Response(
                  jsonEncode(<String, dynamic>{'session_id': 'fresh-1'}), 201);
            }
            return fail('unexpected path ${req.url.path}');
          }),
        ),
        session,
        reportNonFatal:
            (Object error, StackTrace stack, {required String reason}) {
          loggedErrors.add(error);
          loggedReasons.add(reason);
        },
      );

      final String? opener = await repo.ensureSession();

      // Fell through to a NEW session (no opening_text on this stub → null opener).
      expect(opener, isNull);
      expect(session.sessionId, 'fresh-1');
      // Retried exactly ONCE (two /latest hits), then the POST.
      expect(latestHits, 2, reason: '/latest is tried, then retried once');
      expect(hitPaths, <String>[
        '/chat/session/latest',
        '/chat/session/latest',
        '/chat/session',
      ]);
      // LOGGED, not swallowed: exactly one non-fatal, carrying the MAPPED
      // Failure (a SocketException maps to NetworkFailure) and a static reason.
      expect(loggedErrors, hasLength(1),
          reason: 'logged once, after the retry also failed');
      expect(loggedErrors.single, isA<NetworkFailure>());
      expect(loggedReasons.single, 'chat_resume_latest_failed');
    });

    test('the single retry RECOVERS: a transient /latest blip resumes and never '
        'logs or opens a new session', () async {
      final SessionRepository session = SessionRepository()
        ..setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: 'tok');

      final List<String> hitPaths = <String>[];
      int latestHits = 0;
      int logCount = 0;

      final ChatRepositoryImpl repo = ChatRepositoryImpl(
        ApiClient(
          baseUrl: 'http://test',
          client: MockClient((http.Request req) async {
            hitPaths.add(req.url.path);
            if (req.url.path == '/chat/session/latest') {
              latestHits++;
              if (latestHits == 1) throw const SocketException('blip');
              return http.Response(
                  jsonEncode(<String, dynamic>{'session_id': 'prior-1'}), 200);
            }
            return fail('must not open a new session after a recovered resume');
          }),
        ),
        session,
        reportNonFatal:
            (Object error, StackTrace stack, {required String reason}) =>
                logCount++,
      );

      final String? opener = await repo.ensureSession();

      expect(opener, isNull, reason: 'a resume serves no opener');
      expect(session.sessionId, 'prior-1', reason: 'the retry resumed the session');
      expect(latestHits, 2, reason: 'first failed, retry succeeded');
      expect(hitPaths, <String>['/chat/session/latest', '/chat/session/latest'],
          reason: 'no /chat/session — the resume recovered');
      expect(logCount, 0, reason: 'a recovered blip is not logged');
    });

    test('concurrent ensureSession calls open exactly ONE session (in-flight guard)',
        () async {
      final SessionRepository session = SessionRepository()
        ..setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: 'tok');

      int startSessionHits = 0;
      final ChatRepositoryImpl repo = ChatRepositoryImpl(
        ApiClient(
          baseUrl: 'http://test',
          client: MockClient((http.Request req) async {
            if (req.url.path == '/chat/session/latest') {
              // No prior session → both concurrent callers race to the POST.
              return http.Response(
                  jsonEncode(<String, dynamic>{'session_id': null}), 200);
            }
            if (req.url.path == '/chat/session') {
              startSessionHits++;
              // A slow open widens the concurrency window a real network has.
              await Future<void>.delayed(const Duration(milliseconds: 20));
              return http.Response(
                  jsonEncode(<String, dynamic>{'session_id': 's1'}), 201);
            }
            return fail('unexpected path ${req.url.path}');
          }),
        ),
        session,
      );

      // Fire two opens in the SAME microtask before either resolves.
      final List<String?> openers =
          await Future.wait(<Future<String?>>[
        repo.ensureSession(),
        repo.ensureSession(),
      ]);

      expect(startSessionHits, 1,
          reason: 'the in-flight guard collapses the double entry to one POST');
      expect(session.sessionId, 's1');
      expect(openers, <String?>[null, null],
          reason: 'both callers await the same open');
    });

    test('an old-build POST returning the worker\'s existing session carries NO '
        'opening_text → ensureSession yields null → canned greeting stays',
        () async {
      // #1197/#1198: once the backend reattach guard ships, a POST /chat/session
      // can return the EXISTING session with no opener. The client must render its
      // canned greeting (ensureSession -> null, which ChatBloc._withOpener keeps),
      // not crash on a missing opening_text.
      final SessionRepository session = SessionRepository()
        ..setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: 'tok');

      final ChatRepositoryImpl repo = ChatRepositoryImpl(
        ApiClient(
          baseUrl: 'http://test',
          client: MockClient((http.Request req) async {
            if (req.url.path == '/chat/session/latest') {
              return http.Response(
                  jsonEncode(<String, dynamic>{'session_id': null}), 200);
            }
            if (req.url.path == '/chat/session') {
              // The reattach response: an id, but NO opening_text.
              return http.Response(
                  jsonEncode(<String, dynamic>{'session_id': 's-existing'}), 201);
            }
            return fail('unexpected path ${req.url.path}');
          }),
        ),
        session,
      );

      final String? opener = await repo.ensureSession();
      expect(opener, isNull,
          reason: 'no opening_text → null → the canned greeting is kept');
      expect(session.sessionId, 's-existing');
    });
  });

  // #478 + honesty cues — the reply's new fields must reach the ChatTurn the
  // bloc consumes, or the named-gaps helper and the blocked/mock cues go dark.
  test('sendMessage carries unanswered_essentials, blocked and is_mock through',
      () async {
    final SessionRepository session = SessionRepository()
      ..setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: 'tok')
      ..setSession('s1');
    final ChatRepositoryImpl repo = ChatRepositoryImpl(
      ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async => http.Response(
              jsonEncode(<String, dynamic>{
                'reply': 'Aur bataiye.',
                'is_mock': true,
                'blocked': false,
                'suggested_followups': <String>['CNC', 'VMC'],
                'unanswered_essentials': <String>['machines', 'experience'],
              }),
              201,
            )),
      ),
      session,
    );

    final ChatTurn turn = await repo.sendMessage('hi');
    expect(turn.reply, 'Aur bataiye.');
    expect(turn.isMock, isTrue);
    expect(turn.blocked, isFalse);
    expect(turn.followups, <String>['CNC', 'VMC']);
    expect(turn.unansweredEssentials, <String>['machines', 'experience']);
  });

  test('sendMessage carries progress, question_kind and occupation through (#649)',
      () async {
    final SessionRepository session = SessionRepository()
      ..setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: 'tok')
      ..setSession('s1');
    final ChatRepositoryImpl repo = ChatRepositoryImpl(
      ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async => http.Response(
              jsonEncode(<String, dynamic>{
                'reply': 'Aap darzi hain?',
                'progress': <String, dynamic>{'answered': 2, 'total': 9},
                'question_kind': 'disambiguate',
                'input_mode': 'options_only',
                'occupation_label': 'darzi',
              }),
              201,
            )),
      ),
      session,
    );

    final ChatTurn turn = await repo.sendMessage('hi');
    expect(turn.progress?.answered, 2);
    expect(turn.progress?.total, 9);
    expect(turn.questionKind, ChatQuestionKind.disambiguate);
    // #770 — input_mode rides the same ChatReply->ChatTurn map.
    expect(turn.inputMode, ChatInputMode.optionsOnly);
    expect(turn.occupationLabel, 'darzi');
  });

  // #896 — the Devanagari read-aloud string rides ChatReply -> ChatTurn so the
  // reply bubble can be spoken correctly; null on an older build.
  test('sendMessage carries tts_text through to the turn (#896)', () async {
    final SessionRepository session = SessionRepository()
      ..setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: 'tok')
      ..setSession('s1');
    final ChatRepositoryImpl repo = ChatRepositoryImpl(
      ApiClient(
        baseUrl: 'http://test',
        // Devanagari bytes: http.Response(String,...) would latin1-encode and
        // throw, so encode UTF-8 explicitly (a real server sends the charset).
        client: MockClient((http.Request req) async => http.Response.bytes(
              utf8.encode(jsonEncode(<String, dynamic>{
                'reply': 'Aap kaunsa kaam karte hain?',
                'tts_text': 'आप कौनसा काम करते हैं?',
              })),
              201,
              headers: <String, String>{
                'content-type': 'application/json; charset=utf-8',
              },
            )),
      ),
      session,
    );

    final ChatTurn turn = await repo.sendMessage('hi');
    expect(turn.reply, 'Aap kaunsa kaam karte hain?');
    expect(turn.ttsText, 'आप कौनसा काम करते हैं?');
  });

  test('sendMessage with no tts_text yields a null-ttsText turn (older build)',
      () async {
    final SessionRepository session = SessionRepository()
      ..setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: 'tok')
      ..setSession('s1');
    final ChatRepositoryImpl repo = ChatRepositoryImpl(
      ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async => http.Response(
              jsonEncode(<String, dynamic>{'reply': 'Theek hai'}),
              201,
            )),
      ),
      session,
    );

    final ChatTurn turn = await repo.sendMessage('hi');
    expect(turn.ttsText, isNull);
  });

  test('a session_ended reply drops the cached chat session id (#649 re-verify)',
      () async {
    final SessionRepository session = SessionRepository()
      ..setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: 'tok')
      ..setSession('s1');
    final ChatRepositoryImpl repo = ChatRepositoryImpl(
      ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async => http.Response(
              jsonEncode(<String, dynamic>{
                'reply': 'Interview poori hui.',
                'session_ended': true,
              }),
              201,
            )),
      ),
      session,
    );

    expect(session.sessionId, 's1');
    await repo.sendMessage('hi');
    expect(session.sessionId, isNull,
        reason: 'session_ended must clear the cached id so "start a fresh chat" '
            'on the Resume/Profile tabs still works');
  });

  // #502 transcript hydration — the persisted transcript is redrawn as bubbles.
  group('loadHistory (#502)', () {
    test('no open session -> [] (best-effort, never hits the network)', () async {
      final SessionRepository session = SessionRepository()
        ..setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: 'tok');
      // No setSession -> sessionId null.
      final ChatRepositoryImpl repo = _repo(session);
      expect(await repo.loadHistory(), isEmpty);
    });

    test('maps rows to bubbles: inbound=worker, {{worker_name}} stripped, '
        'null-body dropped, order preserved', () async {
      final SessionRepository session = SessionRepository()
        ..setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: 'tok')
        ..setSession('s1');
      late http.Request captured;
      final ChatRepositoryImpl repo = ChatRepositoryImpl(
        ApiClient(
          baseUrl: 'http://test',
          client: MockClient((http.Request req) async {
            captured = req;
            return http.Response(
              jsonEncode(<String, dynamic>{
                'messages': <Map<String, dynamic>>[
                  <String, dynamic>{
                    'direction': 'outbound',
                    'body_text': '{{worker_name}} ji, Namaste!',
                    'created_at': '2026-07-23T10:00:00.000Z',
                  },
                  <String, dynamic>{
                    'direction': 'inbound',
                    'body_text': 'CNC operator hoon',
                    'created_at': '2026-07-23T10:01:00.000Z',
                  },
                  // A voice row before its transcript lands — dropped, not empty.
                  <String, dynamic>{
                    'direction': 'inbound',
                    'body_text': null,
                    'created_at': '2026-07-23T10:02:00.000Z',
                  },
                ],
              }),
              200,
            );
          }),
        ),
        session,
      );

      final List<ChatMessage> history = await repo.loadHistory();

      expect(captured.url.path, '/chat/sessions/s1/messages');
      expect(captured.headers['authorization'], 'Bearer tok');
      expect(history.length, 2, reason: 'the null-body voice row is dropped');
      expect(history[0].fromWorker, isFalse);
      expect(history[0].text, 'Namaste!',
          reason: 'the {{worker_name}} vocative is stripped for the name-less client');
      expect(history[1].fromWorker, isTrue);
      expect(history[1].text, 'CNC operator hoon');
    });

    // #896 — a hydrated OUTBOUND row's `tts_text` rides the bot bubble (with the
    // {{worker_name}} placeholder stripped, exactly like the body); the worker's
    // own bubble never carries a read-aloud script.
    test('maps tts_text onto the BOT bubble; the worker bubble stays null (#896)',
        () async {
      final SessionRepository session = SessionRepository()
        ..setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: 'tok')
        ..setSession('s1');
      final ChatRepositoryImpl repo = ChatRepositoryImpl(
        ApiClient(
          baseUrl: 'http://test',
          // UTF-8 bytes for the Devanagari tts_text (see the sendMessage note).
          client: MockClient((http.Request req) async => http.Response.bytes(
                utf8.encode(jsonEncode(<String, dynamic>{
                  'messages': <Map<String, dynamic>>[
                    <String, dynamic>{
                      'direction': 'outbound',
                      'body_text':
                          '{{worker_name}} ji, Aap kaunsa kaam karte hain?',
                      // The placeholder is stripped from the spoken text too.
                      'tts_text': '{{worker_name}} आप कौनसा काम करते हैं?',
                      'created_at': '2026-08-13T10:00:00.000Z',
                    },
                    <String, dynamic>{
                      'direction': 'inbound',
                      'body_text': 'CNC operator hoon',
                      'created_at': '2026-08-13T10:01:00.000Z',
                    },
                  ],
                })),
                200,
                headers: <String, String>{
                  'content-type': 'application/json; charset=utf-8',
                },
              )),
        ),
        session,
      );

      final List<ChatMessage> history = await repo.loadHistory();
      expect(history.length, 2);
      // Bot bubble: SHOWS the romanized body, SPEAKS the Devanagari sibling —
      // both name-stripped for the name-less client (§2).
      expect(history[0].fromWorker, isFalse);
      expect(history[0].text, 'Aap kaunsa kaam karte hain?');
      expect(history[0].ttsText, 'आप कौनसा काम करते हैं?');
      // The worker's own bubble never carries a read-aloud script.
      expect(history[1].fromWorker, isTrue);
      expect(history[1].ttsText, isNull);
    });

    test('an outbound row with no tts_text hydrates a null-ttsText bot bubble',
        () async {
      final SessionRepository session = SessionRepository()
        ..setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: 'tok')
        ..setSession('s1');
      final ChatRepositoryImpl repo = ChatRepositoryImpl(
        ApiClient(
          baseUrl: 'http://test',
          client: MockClient((http.Request req) async => http.Response(
                jsonEncode(<String, dynamic>{
                  'messages': <Map<String, dynamic>>[
                    <String, dynamic>{
                      'direction': 'outbound',
                      'body_text': 'Namaste!',
                      'created_at': '2026-08-13T10:00:00.000Z',
                    },
                  ],
                }),
                200,
              )),
        ),
        session,
      );

      final List<ChatMessage> history = await repo.loadHistory();
      expect(history.single.text, 'Namaste!');
      expect(history.single.ttsText, isNull,
          reason: 'no tts_text -> read-aloud falls back to the body text');
    });

    test('a server error degrades to [] — hydration never blocks chat-open',
        () async {
      final SessionRepository session = SessionRepository()
        ..setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: 'tok')
        ..setSession('s1');
      final ChatRepositoryImpl repo = ChatRepositoryImpl(
        ApiClient(
          baseUrl: 'http://test',
          client: MockClient((http.Request req) async =>
              http.Response('{"message":"boom"}', 500)),
        ),
        session,
      );
      expect(await repo.loadHistory(), isEmpty);
    });
  });
}
