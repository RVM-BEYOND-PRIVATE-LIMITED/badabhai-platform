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

    testWidgets('page sits on warm cream, not the default grey/white',
        (tester) async {
      final ThemeData theme = AppTheme.light();
      expect(theme.scaffoldBackgroundColor, AppColors.surfacePage);
      expect(theme.scaffoldBackgroundColor, const Color(0xFFFFF6E8));
    });

    testWidgets('green is the action colour (primary), vermilion is the brand',
        (tester) async {
      final ThemeData theme = AppTheme.light();
      expect(theme.colorScheme.primary, AppColors.success); // green action
      expect(theme.colorScheme.secondary, AppColors.brand); // vermilion brand
      expect(theme.colorScheme.error, AppColors.danger);
    });

    testWidgets('no cold blue leaked into the scheme', (tester) async {
      // The old seed was #4F8CFF; assert it is gone.
      expect(AppTheme.light().colorScheme.primary,
          isNot(const Color(0xFF4F8CFF)));
    });

    testWidgets('primary CTA (FilledButton) is the green action colour',
        (tester) async {
      final ButtonStyle? style = AppTheme.light().filledButtonTheme.style;
      final Color? bg = style?.backgroundColor?.resolve(<WidgetState>{});
      expect(bg, AppColors.success);
    });

    testWidgets('app bar wears the cream chrome', (tester) async {
      final ThemeData theme = AppTheme.light();
      expect(theme.appBarTheme.backgroundColor, AppColors.surfacePage);
      expect(theme.appBarTheme.centerTitle, isTrue);
    });
  });
}
