import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart';

/// #1660 — the import read's EXTRACTION signal.
///
/// A `parsed` + `route: chat` + `failure_reason: null` row is a clean success by
/// every other field on the wire, and is exactly what a spend cap, a
/// citation-gated document or a résumé carrying none of the target fields also
/// produces. The client has to be able to tell those apart, and it must not
/// guess when the server says nothing.
void main() {
  Map<String, dynamic> row(Map<String, dynamic> extra) => <String, dynamic>{
        'import_id': 'imp-1',
        'status': 'parsed',
        'route': 'chat',
        'failure_reason': null,
        ...extra,
      };

  test('an explicit yielded_nothing flag is read', () {
    expect(
      ResumeImportDto.fromJson(row(<String, dynamic>{'yielded_nothing': true}))
          .learnedNothing,
      isTrue,
    );
    expect(
      ResumeImportDto.fromJson(row(<String, dynamic>{'yielded_nothing': false}))
          .learnedNothing,
      isFalse,
    );
  });

  test('a fields_extracted count of zero is read the same way', () {
    expect(
      ResumeImportDto.fromJson(row(<String, dynamic>{'fields_extracted': 0}))
          .learnedNothing,
      isTrue,
    );
    expect(
      ResumeImportDto.fromJson(row(<String, dynamic>{'fields_extracted': 4}))
          .learnedNothing,
      isFalse,
    );
  });

  test('neither field present means UNKNOWN, never "nothing"', () {
    // The field is still landing server-side (#1656). Until it does, this must
    // behave exactly as the build before it did: no claim either way.
    final ResumeImportDto dto =
        ResumeImportDto.fromJson(row(const <String, dynamic>{}));
    expect(dto.yieldedNothing, isNull);
    expect(dto.fieldsExtracted, isNull);
    expect(dto.learnedNothing, isFalse);
  });
}
