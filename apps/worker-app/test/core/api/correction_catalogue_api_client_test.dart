import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/api/mock_api_client.dart';

/// #1596 — the correction catalogues' wire contract
/// (`worker-catalogue.controller.ts`): `{skills: [{skill_id, label}]}` and
/// `{machines: [{machine_id, label}]}`. A renamed key is a silently empty
/// picker, so both the route and the keys are pinned here.
void main() {
  group('CatalogueOptionDto.listFromJson', () {
    test('absent / null / non-list parses to []', () {
      expect(CatalogueOptionDto.listFromJson(null, idKey: 'skill_id'),
          isEmpty);
      expect(
          CatalogueOptionDto.listFromJson('x', idKey: 'skill_id'), isEmpty);
      expect(
          CatalogueOptionDto.listFromJson(<String, dynamic>{},
              idKey: 'skill_id'),
          isEmpty);
    });

    test('keeps server order; skips malformed, label-less and repeat ids', () {
      final List<CatalogueOptionDto> out = CatalogueOptionDto.listFromJson(
        <dynamic>[
          <String, dynamic>{'skill_id': 'skill_b', 'label': 'B'},
          'not-a-map',
          <String, dynamic>{'skill_id': 'skill_no_label'},
          <String, dynamic>{'skill_id': 'skill_null_label', 'label': null},
          <String, dynamic>{'skill_id': 'skill_blank', 'label': '  '},
          <String, dynamic>{'skill_id': '', 'label': 'No id'},
          <String, dynamic>{'skill_id': 7, 'label': 'Numeric id'},
          <String, dynamic>{'label': 'Missing id'},
          <String, dynamic>{'skill_id': 'skill_a', 'label': 'A'},
          <String, dynamic>{'skill_id': 'skill_b', 'label': 'B again'},
        ],
        idKey: 'skill_id',
      );
      expect(out, const <CatalogueOptionDto>[
        CatalogueOptionDto(id: 'skill_b', label: 'B'),
        CatalogueOptionDto(id: 'skill_a', label: 'A'),
      ]);
    });

    test('reads the id from the given key only', () {
      expect(
        CatalogueOptionDto.listFromJson(
          <dynamic>[
            <String, dynamic>{'skill_id': 'skill_x', 'label': 'X'},
          ],
          idKey: 'machine_id',
        ),
        isEmpty,
      );
    });
  });

  group('id-list correction bodies', () {
    test('skills', () {
      expect(
        const SkillsCorrection(<String>['skill_fanuc']).toJson(),
        <String, dynamic>{
          'field': 'skills',
          'skill_ids': <String>['skill_fanuc'],
        },
      );
    });

    test('machines', () {
      expect(
        const MachinesCorrection(<String>['mach_vmc']).toJson(),
        <String, dynamic>{
          'field': 'machines',
          'machine_ids': <String>['mach_vmc'],
        },
      );
    });

    test('client caps mirror the contract ceilings', () {
      expect(kMaxCorrectionSkills, 50);
      expect(kMaxCorrectionMachines, 32);
    });
  });

  group('ApiClient catalogue reads', () {
    ApiClient apiReturning(
      Map<String, dynamic> body,
      void Function(http.Request) onRequest,
    ) {
      return ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async {
          onRequest(req);
          return http.Response(jsonEncode(body), 200);
        }),
      );
    }

    test('getSkillOptions GETs the worker route with the bearer', () async {
      late http.Request captured;
      final ApiClient api = apiReturning(
        <String, dynamic>{
          'skills': <Map<String, dynamic>>[
            <String, dynamic>{
              'skill_id': 'skill_gdt_reading',
              'label': 'GD&T / drawing reading',
            },
            <String, dynamic>{
              'skill_id': 'skill_fanuc',
              'label': 'Fanuc control operation',
            },
          ],
        },
        (http.Request r) => captured = r,
      );

      final List<CatalogueOptionDto> skills =
          await api.getSkillOptions(authToken: 'tok');

      expect(captured.method, 'GET');
      expect(captured.url.path, '/workers/me/skills/options');
      expect(captured.headers['authorization'], 'Bearer tok');
      expect(skills, const <CatalogueOptionDto>[
        CatalogueOptionDto(
            id: 'skill_gdt_reading', label: 'GD&T / drawing reading'),
        CatalogueOptionDto(id: 'skill_fanuc', label: 'Fanuc control operation'),
      ]);
    });

    test('getMachineOptions GETs the worker route and reads machine_id',
        () async {
      late http.Request captured;
      final ApiClient api = apiReturning(
        <String, dynamic>{
          'machines': <Map<String, dynamic>>[
            <String, dynamic>{'machine_id': 'mach_vmc', 'label': 'VMC'},
          ],
        },
        (http.Request r) => captured = r,
      );

      final List<CatalogueOptionDto> machines =
          await api.getMachineOptions(authToken: 'tok');

      expect(captured.url.path, '/workers/me/machines/options');
      expect(captured.headers['authorization'], 'Bearer tok');
      expect(machines.single,
          const CatalogueOptionDto(id: 'mach_vmc', label: 'VMC'));
    });

    test('a missing or null list key is an empty catalogue, not a throw',
        () async {
      final ApiClient api =
          apiReturning(<String, dynamic>{'skills': null}, (_) {});
      expect(await api.getSkillOptions(authToken: 'tok'), isEmpty);
      final ApiClient api2 = apiReturning(<String, dynamic>{}, (_) {});
      expect(await api2.getMachineOptions(authToken: 'tok'), isEmpty);
    });

    test('a 403 (consent gate) surfaces as an ApiException', () async {
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async =>
            http.Response('{"message":"consent required"}', 403)),
      );
      await expectLater(
        api.getSkillOptions(authToken: 'tok'),
        throwsA(isA<ApiException>()
            .having((ApiException e) => e.statusCode, 'statusCode', 403)),
      );
    });
  });

  group('MockApiClient catalogue parity', () {
    final MockApiClient api = MockApiClient();

    test('skill catalogue: canonical ids, readable labels, unique', () async {
      final List<CatalogueOptionDto> skills =
          await api.getSkillOptions(authToken: 'mock');
      expect(skills, isNotEmpty);
      expect(skills.length, lessThanOrEqualTo(kMaxCorrectionSkills));
      expect(skills.map((CatalogueOptionDto o) => o.id).toSet(),
          hasLength(skills.length));
      for (final CatalogueOptionDto o in skills) {
        expect(o.id, startsWith('skill_'));
        expect(o.label.trim(), isNotEmpty);
        expect(o.label, isNot(contains('_')));
      }
    });

    test('machine catalogue: canonical ids, readable labels, unique',
        () async {
      final List<CatalogueOptionDto> machines =
          await api.getMachineOptions(authToken: 'mock');
      expect(machines, isNotEmpty);
      expect(machines.length, lessThanOrEqualTo(kMaxCorrectionMachines));
      expect(machines.map((CatalogueOptionDto o) => o.id).toSet(),
          hasLength(machines.length));
      for (final CatalogueOptionDto o in machines) {
        expect(o.id, startsWith('mach_'));
        expect(o.label.trim(), isNotEmpty);
        expect(o.label, isNot(contains('_')));
      }
    });
  });
}
