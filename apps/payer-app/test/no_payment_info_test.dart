import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payer_app/core/widgets/bb_unlock_dialog.dart';

/// #2589 — RECORDED DECISION, made enforceable.
///
/// Owner ruling (4 Nov 2026), on top of CLAUDE.md §12: NO payment information
/// of any kind in the mobile app. Payment and payout flows live on payer-web
/// only. That means no agency payout request / payout history / KYC (PAN, bank,
/// IFSC) screens, no "Manage plan on web" / "Buy credits on web" pointers, no
/// plan / boost / top-up client calls, and no ₹ amount on a credit spend or the
/// credit history. Job pay (salary) on postings is NOT payment information and
/// stays — so this fence scans only the money surfaces, never the pay band.
///
/// It fails the instant any of those reappear.
void main() {
  /// Every Dart source under `lib/`.
  List<File> libSources() => Directory('lib')
      .listSync(recursive: true)
      .whereType<File>()
      .where((File f) => f.path.endsWith('.dart'))
      .toList();

  /// The string literals on a file's non-comment lines — what can render.
  List<String> literalsOf(File f) {
    final RegExp literal = RegExp(r"'([^'\\]|\\.)*'" '|' r'"([^"\\]|\\.)*"');
    final List<String> out = <String>[];
    for (final String line in f.readAsLinesSync()) {
      if (line.trimLeft().startsWith('//')) continue;
      out.addAll(literal.allMatches(line).map((RegExpMatch m) => m[0]!));
    }
    return out;
  }

  test('no payout / KYC / earnings screen or cubit ships in the app', () {
    final Iterable<String> paths =
        libSources().map((File f) => f.path.toLowerCase());
    for (final String path in paths) {
      for (final String banned in <String>['payout', 'kyc', 'earnings']) {
        expect(path.contains(banned), isFalse,
            reason: '$path — payout/KYC/earnings UI belongs on payer-web only');
      }
    }
  });

  test(
      'no money route is called from the app (payouts, KYC, earnings, plan, '
      'boost, quota top-up)', () {
    const List<String> bannedRoutes = <String>[
      '/payer/agency/payouts',
      '/payer/agency/kyc',
      '/payer/agency/earnings',
      "/plan'",
      "/boost'",
      "/quota-topup'",
    ];
    for (final File f in libSources()) {
      final String src = f.readAsStringSync();
      for (final String route in bannedRoutes) {
        expect(src.contains(route), isFalse,
            reason: '${f.path} calls the money route "$route" (#2589)');
      }
    }
  });

  test('no purchase / payout / bank-detail copy renders anywhere', () {
    final List<RegExp> banned = <RegExp>[
      RegExp('manage plan', caseSensitive: false),
      RegExp('buy credits', caseSensitive: false),
      RegExp('buy plan', caseSensitive: false),
      RegExp('top up quota', caseSensitive: false),
      RegExp('boost reach', caseSensitive: false),
      RegExp('payout', caseSensitive: false),
      RegExp(r'\bIFSC\b'),
      RegExp(r'\bPAN\b'),
      RegExp('bank account', caseSensitive: false),
      RegExp('BadaBhai website', caseSensitive: false),
    ];
    for (final File f in libSources()) {
      for (final String lit in literalsOf(f)) {
        for (final RegExp re in banned) {
          expect(re.hasMatch(lit), isFalse,
              reason:
                  '${f.path} renders $lit — payment UI is web-only (#2589)');
        }
      }
    }
  });

  test('no ₹ amount on a credit spend, an unlock, or the credit history', () {
    // The credit / unlock surfaces. Pay-band screens (post / edit job, the
    // posting chat draft) are deliberately NOT here: salary stays.
    const List<String> creditSurfaces = <String>[
      'lib/core/widgets/bb_unlock_dialog.dart',
      'lib/features/credits/presentation/credits_screen.dart',
      'lib/features/credits/presentation/cubit/credits_screen_cubit.dart',
      'lib/core/session/credits_cubit.dart',
      'lib/features/find/presentation/find_screen.dart',
      'lib/features/find/presentation/candidate_search_view.dart',
      'lib/features/find/presentation/widgets/candidate_card.dart',
      'lib/features/find/presentation/cubit/find_cubit.dart',
      'lib/features/find/presentation/reveal_screen.dart',
      'lib/features/home/presentation/home_screen.dart',
    ];
    final RegExp rupee =
        RegExp(r'₹|\\u20b9|\bINR\b|\bRs\.?\s?\d', caseSensitive: false);
    for (final String path in creditSurfaces) {
      final File f = File(path);
      expect(f.existsSync(), isTrue, reason: '$path moved — update the fence');
      for (final String lit in literalsOf(f)) {
        expect(rupee.hasMatch(lit), isFalse,
            reason: '$path renders $lit — credits only, never ₹ (#2589)');
      }
    }
  });

  testWidgets('the unlock dialog states the spend in credits only',
      (WidgetTester tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (BuildContext context) => TextButton(
            onPressed: () =>
                showUnlockDialog(context, shownName: 'R••••', creditsAfter: 9),
            child: const Text('open'),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();

    expect(find.text('Unlock for 1 credit'), findsOneWidget);
    expect(find.textContaining('1 credit will be used', findRichText: true),
        findsOneWidget);
    expect(find.textContaining('₹', findRichText: true), findsNothing);
  });
}
