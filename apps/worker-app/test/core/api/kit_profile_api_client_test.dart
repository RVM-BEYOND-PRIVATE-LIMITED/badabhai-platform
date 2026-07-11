import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';

void main() {
  group('ApiClient interview-kit + profile-summary (contract parse)', () {
    test('getInterviewKits parses {kits:[...]} over the PUBLIC route (no bearer)',
        () async {
      late http.Request captured;
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async {
          captured = req;
          return http.Response(
            jsonEncode(<String, dynamic>{
              'kits': <Map<String, dynamic>>[
                <String, dynamic>{
                  'trade_key': 'cnc_operator',
                  'display_name': 'CNC Operator',
                },
                <String, dynamic>{
                  'trade_key': 'fitter',
                  'display_name': 'Fitter',
                },
              ],
            }),
            200,
          );
        }),
      );

      final List<InterviewKitListItem> kits = await api.getInterviewKits();

      expect(captured.method, 'GET');
      expect(captured.url.path, '/interview-kits');
      expect(captured.headers['authorization'], isNull); // public route
      expect(kits, hasLength(2));
      expect(kits.first.tradeKey, 'cnc_operator');
      expect(kits.first.displayName, 'CNC Operator');
      expect(kits[1].tradeKey, 'fitter');
    });

    test('getInterviewKit parses the prep-pack content shape exactly', () async {
      late http.Request captured;
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async {
          captured = req;
          return http.Response(
            jsonEncode(<String, dynamic>{
              'trade_key': 'cnc_operator',
              'display_name': 'CNC Operator',
              'overview': 'ov',
              'common_questions': <String>['q1', 'q2'],
              'practical_questions': <String>['p1'],
              'safety_questions': <String>['s1'],
              'drawing_measurement_questions': <String>['d1'],
              'skill_checklist': <String>['c1'],
              'revise_before': <String>['r1'],
              'documents_to_carry': <String>['doc1'],
              'common_mistakes': <String>['m1'],
              'hinglish_note': 'note',
            }),
            200,
          );
        }),
      );

      final InterviewKitContentDto kit = await api.getInterviewKit('cnc_operator');

      expect(captured.url.path, '/interview-kits/cnc_operator');
      expect(kit.tradeKey, 'cnc_operator');
      expect(kit.displayName, 'CNC Operator');
      expect(kit.commonQuestions, <String>['q1', 'q2']);
      expect(kit.practicalQuestions, <String>['p1']);
      expect(kit.documentsToCarry, <String>['doc1']);
      expect(kit.commonMistakes, <String>['m1']);
      expect(kit.hinglishNote, 'note');
    });

    test('getProfileSummary sends the bearer + parses the NAMELESS DTO', () async {
      late http.Request captured;
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async {
          captured = req;
          return http.Response(
            jsonEncode(<String, dynamic>{
              'profile_status': 'confirmed',
              'confirmed_at': '2026-06-01T00:00:00.000Z',
              'trade': <String, dynamic>{
                'canonical_trade_id': 'dom_cnc_machining',
                'canonical_role_id': 'role_cnc_turner_operator',
                'display_name': 'CNC Operator',
              },
              'city': 'Pune',
              'strength': 8,
            }),
            200,
          );
        }),
      );

      final ProfileSummaryDto dto =
          await api.getProfileSummary(authToken: 'tok');

      expect(captured.method, 'GET');
      expect(captured.url.path, '/workers/me/profile-summary');
      expect(captured.headers['authorization'], 'Bearer tok');
      expect(dto.profileStatus, 'confirmed');
      expect(dto.confirmedAt, '2026-06-01T00:00:00.000Z');
      expect(dto.tradeDisplayName, 'CNC Operator');
      expect(dto.canonicalTradeId, 'dom_cnc_machining');
      expect(dto.canonicalRoleId, 'role_cnc_turner_operator');
      expect(dto.city, 'Pune');
      expect(dto.strength, 8);
    });

    test('getProfileSummary tolerates a missing trade block + null fields',
        () async {
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async => http.Response(
              jsonEncode(<String, dynamic>{
                'profile_status': 'none',
                'confirmed_at': null,
                'city': null,
                'strength': 0,
              }),
              200,
            )),
      );

      final ProfileSummaryDto dto =
          await api.getProfileSummary(authToken: 'tok');

      expect(dto.profileStatus, 'none');
      expect(dto.confirmedAt, isNull);
      expect(dto.tradeDisplayName, isNull);
      expect(dto.canonicalTradeId, isNull);
      expect(dto.city, isNull);
      expect(dto.strength, 0);
    });
  });
}
