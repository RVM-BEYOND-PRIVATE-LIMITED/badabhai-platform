import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// A one-way ratchet against new hard-coded colours (#2824 item 7).
///
/// Screens must read theme roles (`context.bb` / `ColorScheme`), because a
/// literal cannot follow the light → ink switch. This guard scans
/// `lib/features` and `lib/core/widgets` and fails when a file's count of
/// `Color(0x…)`, `Colors.*` (except `transparent`) or a palette constant
/// (`OnboardingColors.*`, `AppColors.*`) goes ABOVE the committed baseline.
///
/// The baseline only goes DOWN: convert a file, lower its number (or delete the
/// entry at zero). To regenerate it after removing colours:
///
/// ```sh
/// UPDATE_COLOR_BASELINE=1 flutter test test/core/theme/hard_coded_color_guard_test.dart
/// ```
///
/// That regeneration is intentionally manual and reviewable — a guard that
/// rewrote its own baseline on every run would not be a guard.
void main() {
  const String baselinePath =
      'test/core/theme/hard_coded_color_baseline.json';
  // Material `Colors.*` only: the lookbehind keeps a token class such as
  // `FormFlowColors` (or any other `…Colors`) from being mistaken for it.
  final RegExp pattern = RegExp(
    r'Color\(0x|(?<![A-Za-z])Colors\.(?!transparent)|OnboardingColors\.|AppColors\.',
  );

  final List<Directory> roots = <Directory>[
    Directory('lib/features'),
    Directory('lib/core/widgets'),
  ];

  test('no new hard-coded colours', () {
    final Map<String, int> current = <String, int>{};
    for (final Directory root in roots) {
      if (!root.existsSync()) continue;
      for (final FileSystemEntity entity in root.listSync(recursive: true)) {
        if (entity is! File || !entity.path.endsWith('.dart')) continue;
        final int count = pattern.allMatches(entity.readAsStringSync()).length;
        if (count > 0) {
          current[entity.path.replaceAll('\\', '/')] = count;
        }
      }
    }

    if (Platform.environment['UPDATE_COLOR_BASELINE'] == '1') {
      final List<String> keys = current.keys.toList()..sort();
      final Map<String, int> ordered = <String, int>{
        for (final String key in keys) key: current[key]!,
      };
      File(baselinePath).writeAsStringSync(
        '${const JsonEncoder.withIndent('  ').convert(ordered)}\n',
      );
      return;
    }

    final File baselineFile = File(baselinePath);
    final Map<String, dynamic> baseline = baselineFile.existsSync()
        ? jsonDecode(baselineFile.readAsStringSync()) as Map<String, dynamic>
        : <String, dynamic>{};

    final List<String> regressions = <String>[];
    current.forEach((String path, int count) {
      final int allowed = (baseline[path] as num?)?.toInt() ?? 0;
      if (count > allowed) {
        regressions.add('$path: $count (baseline $allowed)');
      }
    });

    expect(
      regressions,
      isEmpty,
      reason:
          'A new hard-coded colour cannot follow the light/ink switch. Use a '
          'theme role (context.bb or ColorScheme) instead. Baseline: '
          '$baselinePath\n${regressions.join('\n')}',
    );
  });
}
