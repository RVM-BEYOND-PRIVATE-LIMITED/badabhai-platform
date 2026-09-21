import 'package:badabhai_worker_app/core/api/api_models.dart';
import 'package:flutter_test/flutter_test.dart';

/// The Layer A profile-surface wire models (ADR-0042 D9, issue #1545).
///
/// Every read is additive and every PUT sends the GET's own entry shapes back,
/// so these lock the two things that break silently: a missing optional field
/// crashing a worker's screen, and a `toJson` that omits a key the server's
/// `.strict()` schemas require.
void main() {
  group('MyWhatsappDto', () {
    test('null number + has_whatsapp true is stored-but-unreadable', () {
      final MyWhatsappDto dto = MyWhatsappDto.fromJson(<String, dynamic>{
        'whatsapp': null,
        'has_whatsapp': true,
      });
      expect(dto.whatsapp, isNull);
      expect(dto.hasWhatsapp, isTrue);
    });

    test('an old server with no body defaults to no number', () {
      final MyWhatsappDto dto = MyWhatsappDto.fromJson(<String, dynamic>{});
      expect(dto.whatsapp, isNull);
      expect(dto.hasWhatsapp, isFalse);
    });
  });

  group('LanguageAbilityDto', () {
    test('round-trips all three abilities through toJson', () {
      const LanguageAbilityDto l = LanguageAbilityDto(
        language: 'hindi',
        canSpeak: true,
        canRead: false,
        canWrite: true,
      );
      expect(l.toJson(), <String, dynamic>{
        'language': 'hindi',
        'can_speak': true,
        'can_read': false,
        'can_write': true,
      });
      final LanguageAbilityDto back =
          LanguageAbilityDto.fromJson(l.toJson());
      expect(back, l);
    });

    test('MyLanguagesDto parses partial + dropped_count and filters junk', () {
      final MyLanguagesDto dto = MyLanguagesDto.fromJson(<String, dynamic>{
        'languages': <dynamic>[
          <String, dynamic>{'language': 'english', 'can_speak': true},
          <String, dynamic>{'language': ''},
          'not-a-map',
        ],
        'partial': true,
        'dropped_count': 2,
      });
      expect(dto.languages.length, 1);
      expect(dto.languages.single.canSpeak, isTrue);
      expect(dto.partial, isTrue);
      expect(dto.droppedCount, 2);
    });
  });

  group('MyOccupationsDto', () {
    test('parses role_id + server label, and an empty body is the ordinary case',
        () {
      final MyOccupationsDto dto = MyOccupationsDto.fromJson(<String, dynamic>{
        'occupations': <dynamic>[
          <String, dynamic>{'role_id': 'role_welder', 'label': 'Welder'},
        ],
      });
      expect(dto.occupations.single.roleId, 'role_welder');
      expect(dto.occupations.single.label, 'Welder');
      expect(MyOccupationsDto.fromJson(<String, dynamic>{}).occupations, isEmpty);
    });
  });

  group('TrainingEntryDto', () {
    test('blank provider becomes null, year is a number', () {
      const TrainingEntryDto t =
          TrainingEntryDto(name: 'CNC course', provider: '  ', year: 2019);
      expect(t.toJson(), <String, dynamic>{
        'name': 'CNC course',
        'provider': null,
        'year': 2019,
      });
    });
  });

  group('MyQualificationsDto', () {
    test('parses trainings + the private licence fields, defaulting absent lists',
        () {
      final MyQualificationsDto dto =
          MyQualificationsDto.fromJson(<String, dynamic>{
        'certificates': <dynamic>[
          <String, dynamic>{
            'name': 'Wireman Licence',
            'issuer': 'State Board',
            'year': 2021,
            'licence_number': 'DL/1234-5',
            'licence_expiry': '2030-01-31',
          },
        ],
        'trainings': <dynamic>[
          <String, dynamic>{'name': 'CNC', 'provider': 'Govt ITI', 'year': 2019},
        ],
        'partial': <dynamic>['educations'],
        'dropped_count': 1,
      });
      expect(dto.certificates.single.licenceNumber, 'DL/1234-5');
      expect(dto.certificates.single.licenceExpiry, '2030-01-31');
      expect(dto.trainings.single.provider, 'Govt ITI');
      expect(dto.educations, isEmpty);
      expect(dto.partial, <String>['educations']);
      expect(dto.droppedCount, 1);
    });
  });

  group('PortfolioItemDto', () {
    test('a link entry sends url, never a storage_key', () {
      const PortfolioItemDto item = PortfolioItemDto(
        kind: 'link',
        url: 'https://example.com/work',
        caption: '  lathe job  ',
      );
      final Map<String, dynamic> json = item.toJson();
      expect(json['kind'], 'link');
      expect(json['url'], 'https://example.com/work');
      expect(json.containsKey('storage_key'), isFalse);
      expect(json['caption'], 'lathe job');
    });

    test('a media entry sends storage_key, never a url', () {
      const PortfolioItemDto item =
          PortfolioItemDto(kind: 'photo', storageKey: 'portfolio/w1/a.jpg');
      final Map<String, dynamic> json = item.toJson();
      expect(json['storage_key'], 'portfolio/w1/a.jpg');
      expect(json.containsKey('url'), isFalse);
      expect(json['caption'], isNull);
    });

    test('MyPortfolioDto parses signed media urls and filters junk', () {
      final MyPortfolioDto dto = MyPortfolioDto.fromJson(<String, dynamic>{
        'items': <dynamic>[
          <String, dynamic>{'kind': 'photo', 'url': 'https://signed', 'caption': null},
          <String, dynamic>{'kind': ''},
        ],
      });
      expect(dto.items.length, 1);
      expect(dto.items.single.url, 'https://signed');
    });
  });
}
