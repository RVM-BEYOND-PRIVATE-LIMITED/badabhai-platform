import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/theme/app_colors.dart';
import 'package:badabhai_worker_app/core/theme/app_theme.dart';

void main() {
  // AppTheme builds its TextTheme via google_fonts (which touches the asset
  // bundle / network). Running inside `testWidgets` gives us the widget binding
  // and tolerates google_fonts' offline fetch the same way the screen tests do.
  group('AppTheme — Desi Vernacular Pop', () {
    testWidgets('uses Material 3', (tester) async {
      expect(AppTheme.light().useMaterial3, isTrue);
    });

    testWidgets('page sits on the cool canvas, not the default grey/white',
        (tester) async {
      final ThemeData theme = AppTheme.light();
      expect(theme.scaffoldBackgroundColor, AppColors.surfacePage);
      expect(theme.scaffoldBackgroundColor, const Color(0xFFF2F4F8));
    });

    testWidgets('haldi is the action colour (primary), blue is the structure',
        (tester) async {
      final ThemeData theme = AppTheme.light();
      expect(theme.colorScheme.primary, AppColors.brand); // haldi action
      expect(theme.colorScheme.secondary, AppColors.blue); // blue structure
      expect(theme.colorScheme.error, AppColors.danger);
    });

    testWidgets('the old material blue seed is gone from primary',
        (tester) async {
      // The old Material seed was #4F8CFF; assert primary is the brand, not it.
      expect(AppTheme.light().colorScheme.primary,
          isNot(const Color(0xFF4F8CFF)));
    });

    testWidgets('primary CTA (FilledButton) is the haldi action colour',
        (tester) async {
      final ButtonStyle? style = AppTheme.light().filledButtonTheme.style;
      final Color? bg = style?.backgroundColor?.resolve(<WidgetState>{});
      expect(bg, AppColors.brand);
    });

    testWidgets('app bar wears the canvas chrome', (tester) async {
      final ThemeData theme = AppTheme.light();
      expect(theme.appBarTheme.backgroundColor, AppColors.surfacePage);
      expect(theme.appBarTheme.centerTitle, isTrue);
    });
  });
}
