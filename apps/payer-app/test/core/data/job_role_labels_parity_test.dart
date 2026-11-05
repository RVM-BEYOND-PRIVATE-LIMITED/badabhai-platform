import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import 'package:payer_app/core/data/models.dart';

/// Keeps the app's role mirror ([kJobRoleKinds] + [kJobRoleLabels]) in step
/// with `JOB_ROLE_LABELS` in `packages/types/src/index.ts` (#2600). Read through
/// the same `'../../packages/…'` relative path the contract tests use (the test
/// runner's cwd is `apps/payer-app`).
Map<String, String> _readJobRoleLabels() {
  final String source =
      File('../../packages/types/src/index.ts').readAsStringSync();
  final int start = source.indexOf('export const JOB_ROLE_LABELS');
  expect(start, isNonNegative, reason: 'JOB_ROLE_LABELS not found');
  final int end = source.indexOf('} satisfies Record', start);
  expect(end, greaterThan(start), reason: 'JOB_ROLE_LABELS end not found');
  final RegExp entry =
      RegExp(r'^\s*([a-z0-9_]+):\s*\{\s*label:\s*"([^"]+)"', multiLine: true);
  return <String, String>{
    for (final RegExpMatch m in entry.allMatches(source.substring(start, end)))
      m.group(1)!: m.group(2)!,
  };
}

void main() {
  test('kJobRoleLabels matches JOB_ROLE_LABELS key for key, label for label',
      () {
    final Map<String, String> source = _readJobRoleLabels();
    expect(source, isNotEmpty);
    expect(kJobRoleLabels, equals(source));
  });

  test('kJobRoleKinds lists exactly the JOB_ROLE_LABELS keys, no duplicates',
      () {
    final Map<String, String> source = _readJobRoleLabels();
    expect(kJobRoleKinds.toSet().length, kJobRoleKinds.length);
    expect(kJobRoleKinds.toSet(), equals(source.keys.toSet()));
  });

  test('the three new kinds resolve to their labels', () {
    expect(jobRoleLabel('edm_wirecut_operator'), 'EDM / Wire-cut Operator');
    expect(
        jobRoleLabel('heat_treatment_technician'), 'Heat-Treatment Technician');
    expect(jobRoleLabel('production_supervisor'), 'Production Supervisor');
  });
}
