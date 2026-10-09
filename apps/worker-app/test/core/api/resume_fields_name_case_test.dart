import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart';

/// ── A WORKER'S NAME IS ALWAYS SHOWN CAPITALISED (owner request) ─────────────
///
/// However the worker typed it, and whatever case the server stored, the name
/// reads "Rishi Ojha" on every surface. Done at THIS wire edge because
/// `full_name` here is the app's only source of the worker's own name on a
/// read: the résumé screens, the Profile tab's identity card and the chat
/// header all reach it through `ResumeSafeFields.displayName`.
///
/// The two WRITE paths already title-case (`NameCubit.submit`, the chat's
/// `_captureNameAnswer`), so this closes the read side.
void main() {
  ResumeFieldsDto parse(Object? fullName) =>
      ResumeFieldsDto.fromJson(<String, dynamic>{'full_name': fullName});

  test('an all-lowercase name is capitalised, word by word', () {
    expect(parse('rishi ojha').fullName, 'Rishi Ojha');
    expect(parse('rishi').fullName, 'Rishi');
  });

  test('a name already capitalised is unchanged', () {
    expect(parse('Rishi Ojha').fullName, 'Rishi Ojha');
  });

  test('deliberate inner capitals SURVIVE — the rest is never lowered', () {
    // titleCaseName only RAISES a word's first letter. Lowering the rest would
    // mangle names their owners spell this way.
    expect(parse('McLeod').fullName, 'McLeod');
    expect(parse('rk sharma').fullName, 'Rk Sharma');
    expect(parse('SHARMA').fullName, 'SHARMA');
  });

  test('three names all get raised', () {
    expect(parse('ram kumar yadav').fullName, 'Ram Kumar Yadav');
  });

  test('surrounding and inner whitespace is handled', () {
    expect(parse('  rishi ojha  ').fullName, 'Rishi Ojha');
    expect(parse('rishi  ojha').fullName, 'Rishi  Ojha');
  });

  test('absent, null, blank and non-string all land on null', () {
    // Null is what "the worker has not set a name" means downstream — the edit
    // screen renders an empty spelling rather than a fabricated placeholder —
    // so a blank or malformed value must not become an empty-string name.
    expect(ResumeFieldsDto.fromJson(<String, dynamic>{}).fullName, isNull);
    expect(parse(null).fullName, isNull);
    expect(parse('   ').fullName, isNull);
    expect(parse(7).fullName, isNull);
    expect(parse(<String>['rishi']).fullName, isNull);
  });

  test('the other fields are untouched by the name handling', () {
    final ResumeFieldsDto dto =
        ResumeFieldsDto.fromJson(<String, dynamic>{
      'full_name': 'rishi ojha',
      'show_photo': false,
      'night_shift_ready': true,
      'has_photo': true,
    });
    expect(dto.fullName, 'Rishi Ojha');
    expect(dto.showPhoto, isFalse);
    expect(dto.nightShiftReady, isTrue);
    expect(dto.hasPhoto, isTrue);
  });
}
