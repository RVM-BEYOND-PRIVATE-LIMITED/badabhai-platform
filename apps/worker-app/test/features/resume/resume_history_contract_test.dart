import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/session/session_repository.dart';
import 'package:badabhai_worker_app/features/resume/data/resume_repository_impl.dart';

/// #1687 — the WIRE CONTRACT of `GET /resume/history`, pinned as literals.
///
/// SOURCE OF TRUTH: `ResumeHistoryItem` / `ResumePendingUpdate` /
/// `ResumeHistoryResponse` in `apps/api/src/resume/resume.dto.ts`, and the
/// `RESUME_SOURCES` / `RESUME_GENERATION_TRIGGERS` sets registered with
/// migration 0124 (ADR-0043). If a value is renamed there, this file must go
/// red in the same PR.
///
/// WHY THE LITERALS ARE SPELLED OUT HERE rather than read off the enums: a
/// test that feeds its own constant to its own parser agrees with itself no
/// matter what the server says. That is exactly the failure
/// `worker-app-action-contract.test.ts` was written for — `source_surface:
/// 'voice_form'` 400'd on every real request while both suites stayed green,
/// because the Dart assertion ran against a MockClient that returned 201 to
/// anything. A Dart-only test cannot fully close that gap; the other half is a
/// TS contract test that READS this client and feeds the literals to the real
/// DTO, which is backend-owned (CLAUDE.md §6) and filed for Backend. What this
/// file CAN do, and does, is make a silent Dart-side rename impossible.
SessionRepository _session({String? token = 'tok'}) {
  final SessionRepository s = SessionRepository();
  if (token != null) {
    s.setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: token);
  }
  return s;
}

ResumeRepositoryImpl _repo(MockClient client, {String? token = 'tok'}) =>
    ResumeRepositoryImpl(
      ApiClient(baseUrl: 'http://test', client: client),
      _session(token: token),
    );

Map<String, dynamic> _item({
  String id = 'r1',
  String? profileId = 'p1',
  Object? source = 'chat',
  Object? trigger = 'profile_confirmed',
  String generatedAt = '2026-09-12T10:00:00.000Z',
  Object? renderStatus = 'rendered',
  Object? renderedAt = '2026-09-12T10:01:00.000Z',
  bool isCurrent = false,
}) => <String, dynamic>{
  'resume_id': id,
  'profile_id': profileId,
  'source': source,
  'trigger': trigger,
  'generated_at': generatedAt,
  'render_status': renderStatus,
  'rendered_at': renderedAt,
  'is_current': isCurrent,
};

void main() {
  group(
    'wire strings (apps/api/src/resume/resume.dto.ts + migration 0124)',
    () {
      test('every RESUME_SOURCES token maps to its own enum member', () {
        final ResumeHistory parsed = ResumeHistory.fromJson(<String, dynamic>{
          'items': <dynamic>[
            _item(id: 'a', source: 'form'),
            _item(id: 'b', source: 'chat'),
            _item(id: 'c', source: 'resume_upload'),
          ],
        });
        expect(
          parsed.items.map((ResumeHistoryItem i) => i.source),
          <ResumeSource>[
            ResumeSource.form,
            ResumeSource.chat,
            ResumeSource.resumeUpload,
          ],
        );
      });

      test('every RESUME_GENERATION_TRIGGERS token maps to its own member', () {
        final ResumeHistory parsed = ResumeHistory.fromJson(<String, dynamic>{
          'items': <dynamic>[
            _item(id: 'a', trigger: 'profile_confirmed'),
            _item(id: 'b', trigger: 'manual'),
            _item(id: 'c', trigger: 'chat_update_accepted'),
            _item(id: 'd', trigger: 'ops_regenerate'),
          ],
        });
        expect(
          parsed.items.map((ResumeHistoryItem i) => i.trigger),
          <ResumeTrigger>[
            ResumeTrigger.profileConfirmed,
            ResumeTrigger.manual,
            ResumeTrigger.chatUpdateAccepted,
            ResumeTrigger.opsRegenerate,
          ],
        );
      });

      test('pending_update carries the two statuses the server can send', () {
        PendingUpdate? p(String status) =>
            PendingUpdate.fromJson(<String, dynamic>{
              'requested_at': '2026-09-24T10:00:00.000Z',
              'status': status,
            });
        expect(p('in_progress')!.isInProgress, isTrue);
        expect(p('in_progress')!.hasFailed, isFalse);
        expect(p('failed')!.hasFailed, isTrue);
        expect(p('failed')!.isInProgress, isFalse);
      });
    },
  );

  group('three server generations: present, absent, malformed', () {
    test('a null source/trigger is a LEGACY row, not an unknown one', () {
      final ResumeHistory parsed = ResumeHistory.fromJson(<String, dynamic>{
        'items': <dynamic>[_item(source: null, trigger: null)],
      });
      expect(parsed.items.single.source, isNull);
      expect(parsed.items.single.trigger, isNull);
    });

    test('an UNKNOWN source/trigger degrades to `unknown`, never throws', () {
      final ResumeHistory parsed = ResumeHistory.fromJson(<String, dynamic>{
        'items': <dynamic>[_item(source: 'telepathy', trigger: 'cosmic_rays')],
      });
      expect(parsed.items.single.source, ResumeSource.unknown);
      expect(parsed.items.single.trigger, ResumeTrigger.unknown);
    });

    test('an absent body reads as an empty history rather than an error', () {
      final ResumeHistory parsed = ResumeHistory.fromJson(<String, dynamic>{});
      expect(parsed.items, isEmpty);
      expect(parsed.pendingUpdate, isNull);
      expect(parsed.isEmpty, isTrue);
    });

    test('malformed rows and a malformed pending_update are dropped, '
        'not thrown', () {
      final ResumeHistory parsed = ResumeHistory.fromJson(<String, dynamic>{
        'items': <dynamic>['not-an-object', 42, _item(id: 'good')],
        'pending_update': 'not-an-object',
      });
      expect(parsed.items.single.resumeId, 'good');
      expect(parsed.pendingUpdate, isNull);
    });

    test('render_status is read fail-closed: only "rendered" is ready and '
        'only "failed" is a failure', () {
      ResumeHistoryItem at(Object? status) =>
          ResumeHistoryItem.fromJson(_item(renderStatus: status));
      expect(at('rendered').isRendered, isTrue);
      expect(at('pending').isRendered, isFalse);
      expect(at('failed').hasFailedRender, isTrue);
      expect(at('something_new').isRendered, isFalse);
      expect(at('something_new').hasFailedRender, isFalse);
      expect(at(null).isRendered, isFalse);
    });

    test('the current entry is whichever row the SERVER marked', () {
      final ResumeHistory parsed = ResumeHistory.fromJson(<String, dynamic>{
        'items': <dynamic>[
          _item(id: 'newest'),
          _item(id: 'marked', isCurrent: true),
        ],
      });
      expect(parsed.current?.resumeId, 'marked');
    });
  });

  group('the repository absorbs a server that has no such route', () {
    test('a 404 reads as an empty history, never an error', () async {
      final ResumeRepositoryImpl repo = _repo(
        MockClient((http.Request req) async => http.Response('{}', 404)),
      );
      expect(await repo.loadResumeHistory(), ResumeHistory.empty);
    });

    test(
      'a 401 ALSO reads as an empty history — an older server routes this '
      'path into the internal-only @Get(":id") and answers 401, not 404',
      () async {
        final ResumeRepositoryImpl repo = _repo(
          MockClient((http.Request req) async => http.Response('{}', 401)),
        );
        expect(await repo.loadResumeHistory(), ResumeHistory.empty);
      },
    );

    test(
      'once absent, the route is not probed again for that repository',
      () async {
        int hits = 0;
        final ResumeRepositoryImpl repo = _repo(
          MockClient((http.Request req) async {
            hits++;
            return http.Response('{}', 404);
          }),
        );
        await repo.loadResumeHistory();
        await repo.loadResumeHistory();
        await repo.loadResumeHistory();
        expect(
          hits,
          1,
          reason: 'a 401 costs a token refresh; do not repeat it',
        );
      },
    );

    test(
      'a TRANSIENT failure is NOT latched — the feature comes back',
      () async {
        int hits = 0;
        final ResumeRepositoryImpl repo = _repo(
          MockClient((http.Request req) async {
            hits++;
            if (hits == 1) return http.Response('{}', 500);
            return http.Response(
              jsonEncode(<String, dynamic>{
                'items': <dynamic>[_item(id: 'r9', isCurrent: true)],
                'pending_update': null,
              }),
              200,
            );
          }),
        );
        expect((await repo.loadResumeHistory()).items, isEmpty);
        expect((await repo.loadResumeHistory()).items.single.resumeId, 'r9');
      },
    );

    test('no session token: empty, and no request is made at all', () async {
      final ResumeRepositoryImpl repo = _repo(
        MockClient((http.Request req) async => fail('must not be hit')),
        token: null,
      );
      expect(await repo.loadResumeHistory(), ResumeHistory.empty);
    });

    test(
      'a real 200 hits GET /resume/history with the bearer attached',
      () async {
        late http.Request captured;
        final ResumeRepositoryImpl repo = _repo(
          MockClient((http.Request req) async {
            captured = req;
            return http.Response(
              jsonEncode(<String, dynamic>{
                'items': <dynamic>[_item(id: 'r1', isCurrent: true)],
                'pending_update': <String, dynamic>{
                  'requested_at': '2026-09-24T10:00:00.000Z',
                  'status': 'in_progress',
                },
              }),
              200,
            );
          }),
        );
        final ResumeHistory history = await repo.loadResumeHistory();
        expect(captured.method, 'GET');
        expect(captured.url.path, '/resume/history');
        expect(captured.headers['authorization'], 'Bearer tok');
        expect(history.items.single.resumeId, 'r1');
        expect(history.pendingUpdate!.isInProgress, isTrue);
      },
    );
  });
}
