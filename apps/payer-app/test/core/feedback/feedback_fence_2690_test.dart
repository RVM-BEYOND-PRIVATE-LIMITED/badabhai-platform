import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// #2690 — a fence against the old feedback patterns coming back:
///  - no raw `showSnackBar` / `SnackBar` outside the one BbToast primitive,
///  - no `AlertDialog` (or ad-hoc `showDialog`) outside the one confirmation
///    primitive,
///  - no exception `toString()` rendered by the UI.
void main() {
  final List<File> sources = Directory('lib')
      .listSync(recursive: true)
      .whereType<File>()
      .where((File f) => f.path.endsWith('.dart'))
      .toList(growable: false);

  test('raw snackbars live only in bb_toast.dart', () {
    for (final File file in sources) {
      final String path = file.path.replaceAll('\\', '/');
      final String text = file.readAsStringSync();
      final bool toastPrimitive = path.endsWith('core/widgets/bb_toast.dart');
      if (!toastPrimitive) {
        expect(text, isNot(contains('showSnackBar(')),
            reason: '$path bypasses BbToast');
        expect(text, isNot(contains('ScaffoldMessenger')),
            reason: '$path bypasses BbToast');
        expect(text, isNot(contains('SnackBar(')),
            reason: '$path builds a raw SnackBar');
      }
    }
  });

  test('dialogs live only in the one confirmation primitive', () {
    for (final File file in sources) {
      final String path = file.path.replaceAll('\\', '/');
      final String text = file.readAsStringSync();
      final bool confirmPrimitive =
          path.endsWith('core/widgets/bb_alert_dialog.dart');
      if (!confirmPrimitive) {
        expect(text, isNot(contains('AlertDialog(')),
            reason: '$path builds an ad-hoc AlertDialog');
        expect(text, isNot(contains('showDialog<')),
            reason: '$path bypasses showBbConfirm');
      }
    }
  });

  test('the UI never renders an exception toString()', () {
    for (final File file in sources) {
      final String path = file.path.replaceAll('\\', '/');
      if (!path.contains('/features/') && !path.contains('/widgets/')) {
        continue;
      }
      expect(file.readAsStringSync(), isNot(contains('e.toString()')),
          reason: '$path leaks an exception string');
    }
  });
}
