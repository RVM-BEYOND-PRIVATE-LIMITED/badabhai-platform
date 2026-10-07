import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/theme/onboarding_theme.dart';

/// ── A FONT FAMILY MUST NOT DECLARE A WEIGHT IT HAS NO CUT FOR ───────────────
///
/// Declaring a weight in pubspec tells the engine a REAL cut of that weight
/// exists, so it paints that file's outlines and emboldens NOTHING. Point one
/// file at 400, 600, 700 and 800 and every heavy style silently renders at
/// Regular.
///
/// That is exactly what happened to Kilimanjaro Sans: the single Regular cut was
/// declared four times, so the form flow's question headlines
/// (`formQuestionHeadline`, w800), its option-card titles (`formCardTitle`,
/// w700) and every `BbButton` label lost their weight and read as unbranded
/// body text. Declared once, the engine picks it for a heavier request and
/// synthesizes the bold.
///
/// Pinned against the pubspec itself, because this is a MANIFEST bug: nothing in
/// Dart can observe it, and a widget test asserting `fontWeight: w800` passes
/// either way — the style is right, the file behind it is not.
void main() {
  final File pubspec = File('pubspec.yaml');

  /// family → the list of weights it declares, in order.
  Map<String, List<String>> declaredWeights() {
    expect(
      pubspec.existsSync(),
      isTrue,
      reason: 'pubspec.yaml must be readable from the package root — this net '
          'is worthless if it silently skips',
    );
    final Map<String, List<String>> out = <String, List<String>>{};
    String? family;
    for (final String raw in pubspec.readAsLinesSync()) {
      final RegExpMatch? fam =
          RegExp(r'^\s*-\s*family:\s*(.+?)\s*$').firstMatch(raw);
      if (fam != null) {
        family = fam.group(1);
        out[family!] = <String>[];
        continue;
      }
      if (family == null) continue;
      // A new top-level key ends the fonts block.
      if (RegExp(r'^[a-zA-Z]').hasMatch(raw)) {
        family = null;
        continue;
      }
      final RegExpMatch? w =
          RegExp(r'^\s*weight:\s*(\d+)\s*$').firstMatch(raw);
      if (w != null) out[family]!.add(w.group(1)!);
    }
    return out;
  }

  /// family → how many DISTINCT asset files it points at.
  Map<String, Set<String>> declaredAssets() {
    final Map<String, Set<String>> out = <String, Set<String>>{};
    String? family;
    for (final String raw in pubspec.readAsLinesSync()) {
      final RegExpMatch? fam =
          RegExp(r'^\s*-\s*family:\s*(.+?)\s*$').firstMatch(raw);
      if (fam != null) {
        family = fam.group(1);
        out[family!] = <String>{};
        continue;
      }
      if (family == null) continue;
      if (RegExp(r'^[a-zA-Z]').hasMatch(raw)) {
        family = null;
        continue;
      }
      final RegExpMatch? a =
          RegExp(r'^\s*-\s*asset:\s*(.+?)\s*$').firstMatch(raw);
      if (a != null) out[family]!.add(a.group(1)!);
    }
    return out;
  }

  test('no family declares more weights than it has distinct font files', () {
    final Map<String, List<String>> weights = declaredWeights();
    final Map<String, Set<String>> assets = declaredAssets();

    for (final String family in weights.keys) {
      final int declared = weights[family]!.length;
      final int files = assets[family]!.length;
      if (declared == 0) continue; // a family that declares no weights at all
      expect(
        declared,
        lessThanOrEqualTo(files),
        reason:
            '"$family" declares $declared weights but ships only $files font '
            'file(s). Every surplus weight is a LIE to the engine: it paints '
            'that file and emboldens nothing, so heavy styles render flat. '
            'Declare each file once, at its own weight.',
      );
    }
  });

  test('Kilimanjaro Sans — the display face — declares its one cut once', () {
    final Map<String, List<String>> weights = declaredWeights();
    final Map<String, Set<String>> assets = declaredAssets();

    expect(OnboardingTypography.displayFamily, 'Kilimanjaro Sans',
        reason: 'if the display family moves, this test must follow it');
    expect(assets['Kilimanjaro Sans'], hasLength(1),
        reason: 'only the Regular cut is in this repo');
    expect(
      weights['Kilimanjaro Sans'],
      <String>['400'],
      reason: 'its true weight, declared once. Adding 600/700/800 against the '
          'same Regular file is what flattened every form-flow question '
          'headline and option-card title.',
    );
  });

  test('every declared font file actually exists', () {
    for (final Set<String> paths in declaredAssets().values) {
      for (final String path in paths) {
        expect(File(path).existsSync(), isTrue,
            reason: '$path is declared in pubspec but missing from the repo');
      }
    }
  });
}
