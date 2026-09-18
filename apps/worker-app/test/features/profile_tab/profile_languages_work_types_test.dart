import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/session/session_repository.dart';
import 'package:badabhai_worker_app/features/profile_tab/data/profile_summary_repository_impl.dart';
import 'package:badabhai_worker_app/features/profile_tab/domain/profile_summary.dart';

/// #1576 — the chat now captures `languages` and `work_types`; the profile must
/// display them as LABELS, with the legacy single `job_type` as the fallback and
/// no raw slug on screen. Empty/absent stays absent (no section, no claim).
void main() {
  SessionRepository session() => SessionRepository()
    ..setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: 'tok');

  ApiClient apiReturning({
    required Map<String, dynamic> preferences,
    int preferencesStatus = 200,
  }) {
    return ApiClient(
      baseUrl: 'http://test',
      client: MockClient((http.Request req) async {
        if (req.url.path == '/workers/me/profile-summary') {
          return http.Response(
            jsonEncode(<String, dynamic>{
              'profile_status': 'confirmed',
              'confirmed_at': '2026-01-01',
              'trade': <String, dynamic>{'display_name': 'Welder'},
              'strength': 6,
            }),
            200,
          );
        }
        if (req.url.path == '/workers/me/work-preferences/options') {
          return http.Response(
            jsonEncode(<String, dynamic>{
              'languages': <String, dynamic>{
                'hindi': 'Hindi',
                'english': 'English',
              },
              'job_type': <String, dynamic>{
                'permanent': 'Permanent',
                'contract': 'Contract',
                'daily_wage': 'Daily wage',
              },
              'documents_ready': <String, dynamic>{},
              'shift': <String, dynamic>{},
            }),
            200,
          );
        }
        if (req.url.path == '/workers/me/work-preferences') {
          if (preferencesStatus != 200) {
            return http.Response('nope', preferencesStatus);
          }
          return http.Response(jsonEncode(preferences), 200);
        }
        return http.Response('not found', 404);
      }),
    );
  }

  test('chat languages resolve to labels, legacy job_type fills work types', () async {
    final ProfileSummaryRepositoryImpl repo = ProfileSummaryRepositoryImpl(
      apiReturning(
        preferences: <String, dynamic>{
          'values': <String, dynamic>{
            'languages': <String>['hindi', 'english'],
            'work_types': null,
            'job_type': 'permanent',
          },
          'partial': <String>[],
        },
      ),
      session(),
    );

    final ProfileSummary s = await repo.summary(includeDisplayExtras: true);
    expect(s.languages, <String>['Hindi', 'English']);
    expect(s.workTypes, <String>['Permanent']);
  });

  test('a non-empty work_types multi WINS over the legacy job_type', () async {
    final ProfileSummaryRepositoryImpl repo = ProfileSummaryRepositoryImpl(
      apiReturning(
        preferences: <String, dynamic>{
          'values': <String, dynamic>{
            'languages': <String>[],
            'work_types': <String>['contract', 'daily_wage'],
            'job_type': 'permanent',
          },
          'partial': <String>[],
        },
      ),
      session(),
    );

    final ProfileSummary s = await repo.summary(includeDisplayExtras: true);
    expect(s.languages, isEmpty);
    expect(s.workTypes, <String>['Contract', 'Daily wage']);
    expect(s.workTypes, isNot(contains('Permanent')),
        reason: 'the legacy single must never show beside the multi');
  });

  test('a preferences read failure still returns the profile, without the section',
      () async {
    final ProfileSummaryRepositoryImpl repo = ProfileSummaryRepositoryImpl(
      apiReturning(
        preferences: <String, dynamic>{},
        preferencesStatus: 500,
      ),
      session(),
    );

    final ProfileSummary s = await repo.summary(includeDisplayExtras: true);
    expect(s.tradeLabel, 'Welder');
    expect(s.languages, isEmpty);
    expect(s.workTypes, isEmpty);
  });

  test('an unknown slug is humanised, never printed raw', () async {
    final ProfileSummaryRepositoryImpl repo = ProfileSummaryRepositoryImpl(
      apiReturning(
        preferences: <String, dynamic>{
          'values': <String, dynamic>{
            'languages': <String>['konkani'],
            'work_types': null,
            'job_type': null,
          },
          'partial': <String>[],
        },
      ),
      session(),
    );

    final ProfileSummary s = await repo.summary(includeDisplayExtras: true);
    expect(s.languages, <String>['Konkani']);
  });
}
