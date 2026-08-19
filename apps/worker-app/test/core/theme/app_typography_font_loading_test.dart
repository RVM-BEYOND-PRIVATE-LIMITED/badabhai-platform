import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';

import 'package:badabhai_worker_app/core/theme/app_typography.dart';

/// Regression: a runtime google_fonts fetch threw an unhandled `ClientException`
/// on a flaky link and, landing before the crash reporter was ready, crashed the
/// app on a real worker device. The fetch is now hard-disabled — building any
/// brand style must NEVER leave the network door open.
void main() {
  // google_fonts touches platform channels when a style is built.
  TestWidgetsFlutterBinding.ensureInitialized();

  // Leave the process in the tests' expected state regardless of outcome.
  tearDown(() => GoogleFonts.config.allowRuntimeFetching = false);

  test('configureFontLoading turns runtime fetching OFF', () {
    GoogleFonts.config.allowRuntimeFetching = true; // the risky default
    AppTypography.configureFontLoading();
    expect(GoogleFonts.config.allowRuntimeFetching, isFalse);
  });

  test('building a display style keeps fetching OFF (no network on a headline)',
      () {
    GoogleFonts.config.allowRuntimeFetching = true;
    AppTypography.display();
    expect(GoogleFonts.config.allowRuntimeFetching, isFalse);
  });

  test('building a body style keeps fetching OFF', () {
    GoogleFonts.config.allowRuntimeFetching = true;
    AppTypography.body();
    expect(GoogleFonts.config.allowRuntimeFetching, isFalse);
  });
}
