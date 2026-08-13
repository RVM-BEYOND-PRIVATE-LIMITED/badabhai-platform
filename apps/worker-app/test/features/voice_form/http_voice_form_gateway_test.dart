import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/session/session_repository.dart';
import 'package:badabhai_worker_app/features/voice_form/data/http_voice_form_gateway.dart';
import 'package:badabhai_worker_app/features/voice_form/domain/voice_form_models.dart';
import 'package:badabhai_worker_app/features/voice_form/domain/voice_review_row.dart';

SessionRepository _session() => SessionRepository()
  ..setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: 'tok')
  ..setSession('unused-chat-id');

Map<String, dynamic> _questionStep({
  String key = 'q_material',
  String type = 'single_select',
  int index = 4,
  int total = 11,
}) =>
    <String, dynamic>{
      'kind': 'question',
      'index': index,
      'total': total,
      'question': <String, dynamic>{
        'question_key': key,
        'prompt_text': 'Kaunsa material?',
        'answer_type': type,
        'options': <dynamic>[
          <String, dynamic>{'option_key': 'mild_steel', 'label_text': 'Mild steel'},
          <String, dynamic>{'option_key': 'stainless', 'label_text': 'Stainless'},
        ],
        'why_text': 'Isse sahi kaam milta hai.',
        'tts_clip_id': 'a1b2c3d4e5f6a7b8',
      },
    };

void main() {
  test('start() parses a question step into a typed NextQuestion (#699)',
      () async {
    final ApiClient api = ApiClient(
      baseUrl: 'http://test',
      client: MockClient((http.Request req) async => http.Response(
            jsonEncode(<String, dynamic>{
              'session_id': 's1',
              'step': _questionStep(),
            }),
            201,
          )),
    );
    final HttpVoiceFormGateway gw = HttpVoiceFormGateway(api, _session());

    final VoiceFormStep step = await gw.start();
    expect(step, isA<NextQuestion>());
    final NextQuestion q = step as NextQuestion;
    expect(q.index, 4);
    expect(q.total, 11);
    expect(q.question.id, 'q_material');
    expect(q.question.kind, VoiceQuestionKind.singleSelect);
    expect(q.question.options.map((VoiceChoice c) => c.key),
        <String>['mild_steel', 'stainless']);
    expect(q.question.whyText, 'Isse sahi kaam milta hai.');
    expect(q.question.ttsAssetKey, 'a1b2c3d4e5f6a7b8');
  });

  test('submit(chips) POSTs kind:chips with option_keys (never labels) (#699)',
      () async {
    late Map<String, dynamic> answerBody;
    final ApiClient api = ApiClient(
      baseUrl: 'http://test',
      client: MockClient((http.Request req) async {
        if (req.url.path == '/profiling/session') {
          return http.Response(
              jsonEncode(<String, dynamic>{'session_id': 's1', 'step': _questionStep()}),
              201);
        }
        // /profiling/answer
        answerBody = jsonDecode(req.body) as Map<String, dynamic>;
        return http.Response(
            jsonEncode(<String, dynamic>{'step': <String, dynamic>{'kind': 'done'}}),
            201);
      }),
    );
    final HttpVoiceFormGateway gw = HttpVoiceFormGateway(api, _session());
    await gw.start(); // learns session_id + question_key

    final VoiceFormStep step =
        await gw.submit(const VoiceAnswer.chips(<String>['mild_steel', 'stainless']), questionKey: 'q_material');

    expect(step, isA<VoiceFormDone>());
    expect(answerBody['session_id'], 's1');
    expect(answerBody['question_key'], 'q_material');
    expect(answerBody['answer'],
        <String, dynamic>{'kind': 'chips', 'option_keys': ['mild_steel', 'stainless']});
  });

  test('a 409 on submit re-attaches as ReattachedTo(current step), never retries '
      'the same body (#699/#727)', () async {
    final List<String> hits = <String>[];
    int answerCalls = 0;
    final ApiClient api = ApiClient(
      baseUrl: 'http://test',
      client: MockClient((http.Request req) async {
        hits.add(req.url.path);
        if (req.url.path == '/profiling/session') {
          // first call = start(); the reattach after 409 = second call.
          return http.Response(
              jsonEncode(<String, dynamic>{'session_id': 's1', 'step': _questionStep(key: 'q_now')}),
              201);
        }
        answerCalls++;
        return http.Response('{"message":"stale"}', 409); // engine moved on
      }),
    );
    final HttpVoiceFormGateway gw = HttpVoiceFormGateway(api, _session());
    await gw.start();

    final VoiceFormStep step =
        await gw.submit(const VoiceAnswer.text('main welder hoon'), questionKey: 'q_material');

    // #727 — wrapped so the cubit knows the answer was REJECTED (do not bank it),
    // carrying the re-read current step.
    expect(step, isA<ReattachedTo>());
    final VoiceFormStep inner = (step as ReattachedTo).step;
    expect(inner, isA<NextQuestion>());
    expect((inner as NextQuestion).question.id, 'q_now',
        reason: 're-read gives the CURRENT question');
    expect(answerCalls, 1, reason: 'the same answer body is never re-POSTed');
    // start (initial) + answer(409) + session (reattach).
    expect(hits, <String>['/profiling/session', '/profiling/answer', '/profiling/session']);
  });

  test('an "unavailable" step is a RETRYABLE STEP, not a failure (#717)', () async {
    // It used to throw. A thrown Failure becomes VoiceFormError, whose only action on the
    // screen is onExit — so the interview ended on the one outcome the server explicitly
    // marks as "nothing was written, send that again". It is now a step the cubit can act on,
    // carrying the engine's own line (which is inside the reply closure, so it has audio).
    final ApiClient api = ApiClient(
      baseUrl: 'http://test',
      client: MockClient((http.Request req) async {
        if (req.url.path == '/profiling/session') {
          return http.Response(
              jsonEncode(<String, dynamic>{'session_id': 's1', 'step': _questionStep()}),
              201);
        }
        return http.Response(
            jsonEncode(<String, dynamic>{
              'step': <String, dynamic>{'kind': 'unavailable', 'reply': 'Thodi der baad koshish karein.'}
            }),
            201);
      }),
    );
    final HttpVoiceFormGateway gw = HttpVoiceFormGateway(api, _session());
    await gw.start();

    final VoiceFormStep step = await gw.submit(const VoiceAnswer.boolean(true), questionKey: 'q_material');
    expect(step, isA<RetryCurrentQuestion>());
    expect((step as RetryCurrentQuestion).reply, 'Thodi der baad koshish karein.');
  });

  test('an UNKNOWN step kind still fails closed — the union is the server\'s (#717)',
      () async {
    // The retryable variant became a step; a kind this client has never seen must NOT be
    // guessed at as "probably retryable", because re-arming the mic against a question that
    // may no longer be on screen is worse than stopping.
    final ApiClient api = ApiClient(
      baseUrl: 'http://test',
      client: MockClient((http.Request req) async {
        if (req.url.path == '/profiling/session') {
          return http.Response(
              jsonEncode(<String, dynamic>{'session_id': 's1', 'step': _questionStep()}),
              201);
        }
        return http.Response(
            jsonEncode(<String, dynamic>{
              'step': <String, dynamic>{'kind': 'something_new'}
            }),
            201);
      }),
    );
    final HttpVoiceFormGateway gw = HttpVoiceFormGateway(api, _session());
    await gw.start();

    await expectLater(
      gw.submit(const VoiceAnswer.boolean(true), questionKey: 'q_material'),
      throwsA(isA<VoiceUnavailableFailure>()),
    );
  });

  test('a SPOKEN answer sends {kind: spoken, voice_note_id} (#717)', () async {
    // The branch that used to throw UnsupportedError('spoken answers have no wire shape
    // yet') — false on the commit it shipped in, since #702 gave it one. Every text / number
    // / city / salary / duration question renders as `open` (no chips, mic only) and the
    // universal pack opens with four of them, so this was the first question of every
    // interview.
    late Map<String, dynamic> body;
    final ApiClient api = ApiClient(
      baseUrl: 'http://test',
      client: MockClient((http.Request req) async {
        if (req.url.path == '/profiling/session') {
          return http.Response(
              jsonEncode(<String, dynamic>{'session_id': 's1', 'step': _questionStep()}),
              201);
        }
        body = jsonDecode(req.body) as Map<String, dynamic>;
        return http.Response(
            jsonEncode(<String, dynamic>{'step': <String, dynamic>{'kind': 'done'}}), 201);
      }),
    );
    final HttpVoiceFormGateway gw = HttpVoiceFormGateway(api, _session());
    await gw.start();

    final VoiceFormStep step = await gw.submit(const VoiceAnswer.spoken('vn-42'), questionKey: 'q_material');

    expect(step, isA<VoiceFormDone>());
    expect(body['answer'], <String, dynamic>{'kind': 'spoken', 'voice_note_id': 'vn-42'});
    // The clip itself never crosses this seam — no path, no bytes, no duration.
    expect(jsonEncode(body).contains('.m4a'), isFalse);
  });

  test('start() publishes the session id the cubit uploads against (#717)', () async {
    final ApiClient api = ApiClient(
      baseUrl: 'http://test',
      client: MockClient((http.Request req) async => http.Response(
            jsonEncode(<String, dynamic>{'session_id': 's-abc', 'step': _questionStep()}),
            201,
          )),
    );
    final HttpVoiceFormGateway gw = HttpVoiceFormGateway(api, _session());

    expect(gw.sessionId, isNull, reason: 'nothing to upload against before start()');
    await gw.start();
    expect(gw.sessionId, 's-abc');
  });

  test('finalize() is OK on committed:true and retryable on committed:false (#699)',
      () async {
    bool commit = true;
    final ApiClient api = ApiClient(
      baseUrl: 'http://test',
      client: MockClient((http.Request req) async {
        if (req.url.path == '/profiling/session') {
          return http.Response(
              jsonEncode(<String, dynamic>{'session_id': 's1', 'step': _questionStep()}),
              201);
        }
        return http.Response(
            jsonEncode(<String, dynamic>{'session_id': 's1', 'committed': commit}),
            201);
      }),
    );
    final HttpVoiceFormGateway gw = HttpVoiceFormGateway(api, _session());
    await gw.start();

    await gw.finalize(); // committed:true → no throw

    commit = false;
    await expectLater(gw.finalize(), throwsA(isA<VoiceUnavailableFailure>()));
  });

  test('finalize() maps the 409 "not finished yet" to a RETRYABLE failure (#717)',
      () async {
    // The frequent retryable case, and it had no test. `ProfilingSessionService.finalize`
    // throws ConflictException — "the engine decides when an interview closes" — which
    // arrives as an ApiException, not a Failure, so it fell through to `mapError`. That has
    // no 409 arm and returns ServerFailure(409) with generic "Something went wrong" copy, so
    // the review screen dead-ended on the one condition the worker could retry out of.
    final ApiClient api = ApiClient(
      baseUrl: 'http://test',
      client: MockClient((http.Request req) async {
        if (req.url.path == '/profiling/session') {
          return http.Response(
              jsonEncode(<String, dynamic>{'session_id': 's1', 'step': _questionStep()}),
              201);
        }
        return http.Response(
            jsonEncode(<String, dynamic>{'message': 'Session s1 is not finished'}), 409);
      }),
    );
    final HttpVoiceFormGateway gw = HttpVoiceFormGateway(api, _session());
    await gw.start();

    await expectLater(gw.finalize(), throwsA(isA<VoiceUnavailableFailure>()));
  });

  test('finalize() still fails closed on a 5xx — not everything is retryable (#717)',
      () async {
    // The 409 arm must not swallow the rest: a 500 is not "send it again in a moment".
    final ApiClient api = ApiClient(
      baseUrl: 'http://test',
      client: MockClient((http.Request req) async {
        if (req.url.path == '/profiling/session') {
          return http.Response(
              jsonEncode(<String, dynamic>{'session_id': 's1', 'step': _questionStep()}),
              201);
        }
        return http.Response('{}', 500);
      }),
    );
    final HttpVoiceFormGateway gw = HttpVoiceFormGateway(api, _session());
    await gw.start();

    await expectLater(
      gw.finalize(),
      throwsA(predicate((Object? e) => e is Failure && e is! VoiceUnavailableFailure)),
    );
  });

  test('no session token fails closed with UnauthorizedFailure (#699)', () {
    final ApiClient api = ApiClient(
      baseUrl: 'http://test',
      client: MockClient((_) async => http.Response('{}', 200)),
    );
    final HttpVoiceFormGateway gw =
        HttpVoiceFormGateway(api, SessionRepository());
    expect(gw.start(), throwsA(isA<UnauthorizedFailure>()));
  });

  // #761 — the advisory lookahead. Predicted next steps keyed by option_key
  // (+ __declined), parsed defensively; a garbage entry is dropped and the step
  // survives.
  test('a question step parses the lookahead map into predicted next steps (#761)',
      () async {
    final ApiClient api = ApiClient(
      baseUrl: 'http://test',
      client: MockClient((http.Request req) async => http.Response(
            jsonEncode(<String, dynamic>{
              'session_id': 's1',
              'step': <String, dynamic>{
                'kind': 'question',
                'index': 4,
                'total': 11,
                'question': <String, dynamic>{
                  'question_key': 'q_material',
                  'prompt_text': 'Kaunsa material?',
                  'answer_type': 'single_select',
                  'options': <dynamic>[
                    <String, dynamic>{
                      'option_key': 'mild_steel',
                      'label_text': 'Mild steel'
                    },
                  ],
                },
                'lookahead': <String, dynamic>{
                  // A predicted next QUESTION, dot-rail via explicit index/total.
                  'mild_steel': <String, dynamic>{
                    'question_key': 'q_thickness',
                    'prompt_text': 'Kitni moti sheet?',
                    'answer_type': 'single_select',
                    'options': <dynamic>[
                      <String, dynamic>{'option_key': 'thin', 'label_text': 'Patli'},
                    ],
                    'index': 5,
                    'total': 11,
                  },
                  // A predicted DONE (question_kind: close), dot-rail via progress.
                  '__declined': <String, dynamic>{
                    'question_kind': 'close',
                    'progress': <String, dynamic>{'answered': 11, 'total': 11},
                  },
                  // Garbage — dropped, and must not take down the step.
                  'garbage': 'not a map',
                },
              },
            }),
            201,
          )),
    );
    final HttpVoiceFormGateway gw = HttpVoiceFormGateway(api, _session());

    final VoiceFormStep step = await gw.start();
    final NextQuestion q = step as NextQuestion;

    final PredictedNext predicted = q.lookahead['mild_steel']!;
    expect(predicted.question!.id, 'q_thickness');
    expect(predicted.question!.kind, VoiceQuestionKind.singleSelect);
    expect(predicted.question!.options.single.key, 'thin');
    expect(predicted.index, 5);
    expect(predicted.total, 11);

    final PredictedNext declined = q.lookahead['__declined']!;
    expect(declined.question, isNull, reason: 'a close prediction has no question');
    expect(declined.index, 11, reason: 'dot-rail from progress.answered');
    expect(declined.total, 11);

    expect(q.lookahead.keys, containsAll(<String>['mild_steel', '__declined']));
    expect(q.lookahead.containsKey('garbage'), isFalse,
        reason: 'the garbage entry is dropped, the step survives');
  });

  test('a question step with NO lookahead yields an empty map (#761)', () async {
    final ApiClient api = ApiClient(
      baseUrl: 'http://test',
      client: MockClient((_) async => http.Response(
            jsonEncode(<String, dynamic>{
              'session_id': 's1',
              'step': _questionStep(),
            }),
            201,
          )),
    );
    final HttpVoiceFormGateway gw = HttpVoiceFormGateway(api, _session());

    final VoiceFormStep step = await gw.start();
    expect((step as NextQuestion).lookahead, isEmpty);
  });
  group('reviewRows() maps GET /profiling/session rows to review rows (#700)', () {
    test('parses rows; a malformed row is dropped, never thrown', () async {
      late String reviewPath;
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async {
          if (req.url.path == '/profiling/session') {
            return http.Response(
                jsonEncode(<String, dynamic>{
                  'session_id': 's1',
                  'step': <String, dynamic>{'kind': 'done'},
                }),
                201);
          }
          reviewPath = req.url.path; // GET /profiling/session/s1
          return http.Response(
            jsonEncode(<String, dynamic>{
              'session_id': 's1',
              'complete': true,
              'rows': <dynamic>[
                <String, dynamic>{
                  'question_key': 'q_trade',
                  'field_label': 'Kaam',
                  'display_value': 'Welder',
                  'answer_type': 'single_select',
                  'status': 'answered',
                  'options': <dynamic>[
                    <String, dynamic>{'option_key': 'welder', 'label_text': 'Welder'},
                    <String, dynamic>{'option_key': 'fitter', 'label_text': 'Fitter'},
                  ],
                },
                <String, dynamic>{
                  'question_key': 'q_salary',
                  'field_label': 'Salary',
                  'display_value': '18000',
                  'answer_type': 'number',
                  'status': 'answered',
                },
                <String, dynamic>{
                  'question_key': 'q_extra',
                  'field_label': 'Extra',
                  'display_value': '',
                  'answer_type': 'boolean',
                  'status': 'declined',
                },
                'not-a-map', // malformed → dropped
                <String, dynamic>{'field_label': 'No key'}, // no question_key → dropped
              ],
            }),
            200,
          );
        }),
      );
      final HttpVoiceFormGateway gw = HttpVoiceFormGateway(api, _session());
      await gw.start();

      final List<VoiceReviewRow> rows = await gw.reviewRows();

      expect(reviewPath, '/profiling/session/s1');
      expect(rows.map((VoiceReviewRow r) => r.questionId),
          <String>['q_trade', 'q_salary', 'q_extra'],
          reason: 'two malformed rows dropped, the three valid ones kept');

      final VoiceReviewRow trade = rows[0];
      expect(trade.fieldLabel, 'Kaam');
      expect(trade.kind, VoiceQuestionKind.singleSelect);
      expect(trade.options.map((VoiceChoice c) => c.key),
          <String>['welder', 'fitter']);
      expect(trade.hasChoices, isTrue);
      expect(trade.numeric, isFalse);
      expect(trade.clipPath, isNull, reason: 'server truth carries no device path');

      final VoiceReviewRow salary = rows[1];
      expect(salary.numeric, isTrue, reason: 'answer_type number lines the digits up');
      expect(salary.hasChoices, isFalse);

      final VoiceReviewRow extra = rows[2];
      expect(extra.declined, isTrue);
      expect(extra.kind, VoiceQuestionKind.boolean);
      expect(extra.hasChoices, isTrue,
          reason: 'a boolean is correctable by chip (Haan/Nahi)');
    });

    test('a non-list rows payload is empty, not a throw', () async {
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async {
          if (req.url.path == '/profiling/session') {
            return http.Response(
                jsonEncode(<String, dynamic>{
                  'session_id': 's1',
                  'step': <String, dynamic>{'kind': 'done'},
                }),
                201);
          }
          return http.Response(
              jsonEncode(<String, dynamic>{'session_id': 's1', 'rows': null}), 200);
        }),
      );
      final HttpVoiceFormGateway gw = HttpVoiceFormGateway(api, _session());
      await gw.start();
      expect(await gw.reviewRows(), isEmpty);
    });

    test('reviewRows() before start() is Unauthorized — no session to read',
        () async {
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        client: MockClient((_) async => http.Response('{}', 200)),
      );
      final HttpVoiceFormGateway gw = HttpVoiceFormGateway(api, _session());
      await expectLater(gw.reviewRows(), throwsA(isA<UnauthorizedFailure>()));
    });
  });
  // #806 — the landed fact rides ON the 409 body the client already receives
  // (`stale_reason`), read straight into `ReattachedTo.answerAlreadyLanded`. No
  // second `GET /profiling/session` (which a lost-response 2G link could drop the
  // same way). A `HttpVoiceFormGateway` whose submit gets a 409 carrying the
  // reason must set the flag from it, fail-soft to false on anything else.
  ApiClient apiWith409({required String answerBody}) => ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async {
          // start() + the re-attach after the 409 both POST /profiling/session.
          if (req.url.path == '/profiling/session') {
            return http.Response(
                jsonEncode(<String, dynamic>{
                  'session_id': 's1',
                  'step': _questionStep(key: 'q_now'),
                }),
                201);
          }
          // /profiling/answer → the stale-answer 409.
          return http.Response(answerBody, 409);
        }),
      );

  Future<ReattachedTo> submitInto409(ApiClient api) async {
    final HttpVoiceFormGateway gw = HttpVoiceFormGateway(api, _session());
    await gw.start();
    final VoiceFormStep step = await gw.submit(
      const VoiceAnswer.spoken('vn-1'),
      questionKey: 'q_material',
    );
    return step as ReattachedTo;
  }

  test('#806 a 409 whose stale_reason is answer_already_landed sets '
      'ReattachedTo.answerAlreadyLanded = true', () async {
    final ApiClient api = apiWith409(
      answerBody: jsonEncode(<String, dynamic>{
        'statusCode': 409,
        'message': 'Question q_material is no longer on screen',
        'error': 'Conflict',
        'stale_reason': 'answer_already_landed',
      }),
    );
    final ReattachedTo step = await submitInto409(api);
    expect(step.answerAlreadyLanded, isTrue);
    // Still the current step, re-read via /profiling/session.
    expect((step.step as NextQuestion).question.id, 'q_now');
  });

  test('#806 a 409 whose stale_reason is "other" fails soft to '
      'answerAlreadyLanded = false', () async {
    final ApiClient api = apiWith409(
      answerBody: jsonEncode(<String, dynamic>{
        'statusCode': 409,
        'message': 'Question was reopened',
        'error': 'Conflict',
        'stale_reason': 'other',
      }),
    );
    final ReattachedTo step = await submitInto409(api);
    expect(step.answerAlreadyLanded, isFalse);
  });

  test('#806 a 409 with NO stale_reason key fails soft to '
      'answerAlreadyLanded = false (under-count, never over-count)', () async {
    final ApiClient api = apiWith409(
      answerBody: jsonEncode(<String, dynamic>{'message': 'stale'}),
    );
    final ReattachedTo step = await submitInto409(api);
    expect(step.answerAlreadyLanded, isFalse);
  });

  test('#806 a 409 with a NON-JSON body fails soft to false (body undecodable)',
      () async {
    final ApiClient api = apiWith409(answerBody: 'gateway timeout, not json');
    final ReattachedTo step = await submitInto409(api);
    expect(step.answerAlreadyLanded, isFalse);
  });

  group('#806 ApiException carries the decoded response body', () {
    test('a non-2xx JSON object response → ApiException.body is the decoded map',
        () async {
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        client: MockClient((_) async => http.Response(
              jsonEncode(<String, dynamic>{
                'statusCode': 409,
                'message': 'stale',
                'stale_reason': 'answer_already_landed',
              }),
              409,
            )),
      );
      final ApiException e = await _captureApiException(
        () => api.profilingAnswer(
          authToken: 'tok',
          body: const <String, dynamic>{'session_id': 's1'},
        ),
      );
      expect(e.statusCode, 409);
      expect(e.body, isNotNull);
      expect(e.body!['stale_reason'], 'answer_already_landed');
    });

    test('a non-JSON (or non-object) body → ApiException.body is null', () async {
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        client: MockClient((_) async => http.Response('502 Bad Gateway', 502)),
      );
      final ApiException e = await _captureApiException(
        () => api.profilingAnswer(
          authToken: 'tok',
          body: const <String, dynamic>{'session_id': 's1'},
        ),
      );
      expect(e.statusCode, 502);
      expect(e.body, isNull);
    });
  });
}

/// Runs [action], asserts it threw an [ApiException], and returns it.
Future<ApiException> _captureApiException(
    Future<void> Function() action) async {
  try {
    await action();
  } on ApiException catch (e) {
    return e;
  }
  fail('expected an ApiException');
}
