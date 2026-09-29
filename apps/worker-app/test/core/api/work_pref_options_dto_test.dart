import 'package:badabhai_worker_app/core/api/api_models.dart';
import 'package:flutter_test/flutter_test.dart';

/// The backend-pending `city_hubs` contract (#1634). The client must parse it
/// additively and degrade safely: absent or malformed ⇒ the picker's hub
/// sections are empty and the state→city cascade carries on unchanged.
void main() {
  group('WorkPrefOptionsDto.cityHubs (#1634)', () {
    test('absent city_hubs parses as empty — old responses unchanged', () {
      final WorkPrefOptionsDto dto = WorkPrefOptionsDto.fromJson(<String, dynamic>{
        'languages': <String, dynamic>{'hindi': 'Hindi'},
        'cities': <dynamic>[],
        'states': <dynamic>['Maharashtra'],
      });
      expect(dto.cityHubs, isEmpty);
    });

    test('parses a full hub through CityHubDto', () {
      final WorkPrefOptionsDto dto = WorkPrefOptionsDto.fromJson(<String, dynamic>{
        'languages': <String, dynamic>{},
        'city_hubs': <dynamic>[
          <String, dynamic>{
            'state': 'Maharashtra',
            'hub_key': 'pune',
            'display': 'Pune',
            'areas': <dynamic>['Chakan', 'Bhosari MIDC'],
            'city_value': 'Pune',
            'popular': true,
          },
        ],
      });
      expect(dto.cityHubs, hasLength(1));
      final CityHubDto hub = dto.cityHubs.single;
      expect(hub.cityValue, 'Pune');
      expect(hub.display, 'Pune');
      expect(hub.state, 'Maharashtra');
      expect(hub.areas, <String>['Chakan', 'Bhosari MIDC']);
      expect(hub.hubKey, 'pune');
      expect(hub.popular, isTrue);
    });

    test('drops a hub with no submittable city_value — never offer a 400', () {
      final WorkPrefOptionsDto dto = WorkPrefOptionsDto.fromJson(<String, dynamic>{
        'languages': <String, dynamic>{},
        'city_hubs': <dynamic>[
          <String, dynamic>{'display': 'Kolhapur', 'areas': <dynamic>['Shiroli']},
          <String, dynamic>{'city_value': '  ', 'display': 'Blank'},
          <String, dynamic>{'city_value': 'Nashik', 'display': 'Nashik'},
          'not-a-map',
        ],
      });
      expect(dto.cityHubs, hasLength(1));
      expect(dto.cityHubs.single.cityValue, 'Nashik');
    });

    test('tolerates missing optional fields (areas/state/popular/hub_key)',
        () {
      final WorkPrefOptionsDto dto = WorkPrefOptionsDto.fromJson(<String, dynamic>{
        'languages': <String, dynamic>{},
        'city_hubs': <dynamic>[
          <String, dynamic>{'city_value': 'Pune', 'display': 'Pune'},
        ],
      });
      final CityHubDto hub = dto.cityHubs.single;
      expect(hub.areas, isEmpty);
      expect(hub.state, isEmpty);
      expect(hub.popular, isFalse);
      expect(hub.hubKey, isEmpty);
    });
  });

  /// #1541 / ADR-0045 R4 — `availability_status`, the closed set the PUT's
  /// strict `z.enum` validates `availability.status` against.
  group('WorkPrefOptionsDto.availabilityStatus (#1541)', () {
    test('parses the served dictionary, preserving server order', () {
      final WorkPrefOptionsDto dto = WorkPrefOptionsDto.fromJson(<String, dynamic>{
        'languages': <String, dynamic>{},
        'availability_status': <String, dynamic>{
          'immediate': 'Immediately',
          'within_week': 'Within a week',
          'within_month': 'Within a month',
          'serving_notice': 'Serving notice',
        },
      });
      expect(dto.availabilityStatus.keys.toList(), <String>[
        'immediate',
        'within_week',
        'within_month',
        'serving_notice',
      ]);
      expect(dto.availabilityStatus['serving_notice'], 'Serving notice');
    });

    test('absent or null parses as empty — an older server', () {
      for (final Map<String, dynamic> json in <Map<String, dynamic>>[
        <String, dynamic>{'languages': <String, dynamic>{}},
        <String, dynamic>{'availability_status': null},
      ]) {
        expect(WorkPrefOptionsDto.fromJson(json).availabilityStatus, isEmpty);
      }
    });

    test('a malformed value parses as empty; a non-string label is skipped',
        () {
      expect(
        WorkPrefOptionsDto.fromJson(<String, dynamic>{
          'availability_status': <dynamic>['immediate'],
        }).availabilityStatus,
        isEmpty,
      );
      expect(
        WorkPrefOptionsDto.fromJson(<String, dynamic>{
          'availability_status': <String, dynamic>{
            'immediate': 'Immediately',
            'within_week': 7,
          },
        }).availabilityStatus,
        <String, String>{'immediate': 'Immediately'},
      );
    });
  });
}
