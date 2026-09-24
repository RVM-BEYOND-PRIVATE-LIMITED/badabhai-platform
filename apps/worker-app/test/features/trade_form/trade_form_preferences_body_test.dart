import 'package:badabhai_worker_app/features/finishing/domain/finishing_models.dart';
import 'package:badabhai_worker_app/features/trade_form/domain/trade_form_models.dart';
import 'package:flutter_test/flutter_test.dart';

/// Review round 1: `PUT /workers/me/work-preferences` clears a key sent as `[]`
/// and leaves an ABSENT key alone, so an untouched field must never be sent.
///
/// #1710 — the trade-form page now PREFILLS from `GET /workers/me/work-preferences`
/// and therefore also sends `touched_only: true`, the server's new-build signal
/// (`worker-preferences.dto.ts`). It is a REQUEST MODE, not an answer: it is never
/// stored, and it is what finally lets an emptied list clear rather than be
/// ignored as a tap-through. Every assertion below therefore expects it beside
/// the answer keys — and the "sends nothing" case means "no ANSWER key".
void main() {
  group('TradeFormPreferences.toJson — only what the worker touched', () {
    test('an untouched page sends no answer key — only the request mode', () {
      expect(const TradeFormPreferences().toJson(),
          <String, dynamic>{'touched_only': true});
    });

    test('a touched list or yes/no is sent, even when emptied again', () {
      final TradeFormPreferences prefs = const TradeFormPreferences()
          .copyWith(languages: <String>{'hindi'})
          .copyWith(languages: <String>{})
          .copyWith(willingToRelocate: true);

      expect(prefs.toJson(), <String, dynamic>{
        'touched_only': true,
        'languages': <String>[],
        'willing_to_relocate': true,
      });
    });

    test('scalars keep their rule: sent only when chosen', () {
      final Map<String, dynamic> body = const TradeFormPreferences()
          .copyWith(shift: 'day', salaryExpectedMax: 20000)
          .toJson();

      expect(body, <String, dynamic>{
        'touched_only': true,
        'shift': 'day',
        'salary_expected_max': 20000,
      });
    });
  });

  group('WorkPreferences.toUpdateBody — only what the worker touched', () {
    test('an untouched form sends nothing', () {
      expect(const WorkPreferences().toUpdateBody(), isEmpty);
    });

    test('a touched city list is sent', () {
      final Map<String, dynamic> body = const WorkPreferences()
          .copyWith(preferredCities: <String>['Pune'])
          .toUpdateBody();

      expect(body, <String, dynamic>{
        'preferred_cities': <String>['Pune'],
      });
    });
  });
}
