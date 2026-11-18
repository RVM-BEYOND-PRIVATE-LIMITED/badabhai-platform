// #2748 item 7a — the "free for workers" line on the sign-up (consent) screen.
//
// It sits OUTSIDE both versioned notice cards, so the consent text a worker
// certifies — and kConsentVersion — are unchanged, and it ships switched off.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart'
    show kConsentVersion;
import 'package:badabhai_worker_app/core/config/remote_config.dart';
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/features/consent/domain/consent_repository.dart';
import 'package:badabhai_worker_app/features/consent/presentation/consent_screen.dart';
import 'package:badabhai_worker_app/features/consent/presentation/cubit/consent_cubit.dart';
import 'package:badabhai_worker_app/features/consent/presentation/widgets/consent_notice_parts.dart';
import 'package:badabhai_worker_app/features/consent/presentation/widgets/employer_sharing_notice.dart';
import 'package:badabhai_worker_app/features/consent/presentation/widgets/free_for_workers_line.dart';

import '../../support/kit_matrix.dart';

class _MockConsentRepository extends Mock implements ConsentRepository {}

void main() {
  final Finder line = find.text(kFreeForWorkersText);

  void switchOn() => BbRemoteConfig.instance.debugSetSnapshot(<String, Object>{
    BbRemoteConfig.kKeyFreeForWorkersLineVisible: true,
  });

  setUp(() async {
    BbRemoteConfig.instance.debugReset();
    await locator.reset();
    locator.registerFactory<ConsentCubit>(
      () => ConsentCubit(_MockConsentRepository()),
    );
  });

  tearDown(() async {
    BbRemoteConfig.instance.debugReset();
    await locator.reset();
  });

  Future<void> pumpConsent(WidgetTester tester) async {
    await tester.pumpWidget(
      MaterialApp(theme: AppTheme.light(), home: const ConsentScreen()),
    );
    await tester.pump();
  }

  testWidgets('switched off (the default): no free line', (
    WidgetTester tester,
  ) async {
    expect(FreeForWorkersLine.isVisible, isFalse);
    await pumpConsent(tester);

    // The bottom of the page, where the line would sit.
    await tester.scrollUntilVisible(
      find.text('Haan, 18+ hoon'),
      120,
      scrollable: find.byType(Scrollable).first,
    );
    expect(line, findsNothing);
    expect(find.byType(FreeForWorkersLine), findsNothing);
  });

  testWidgets('switched on: the line shows, outside every notice card', (
    WidgetTester tester,
  ) async {
    switchOn();
    await pumpConsent(tester);

    await tester.scrollUntilVisible(
      line,
      120,
      scrollable: find.byType(Scrollable).first,
    );
    expect(line, findsOneWidget);
    expect(
      find.descendant(of: find.byType(ConsentNoticeCard), matching: line),
      findsNothing,
      reason: 'never inside a notice card — not part of what the tick grants',
    );
    expect(
      find.descendant(of: find.byType(EmployerSharingNotice), matching: line),
      findsNothing,
    );
  });

  testWidgets('switched on: both notices still render as approved', (
    WidgetTester tester,
  ) async {
    switchOn();
    await pumpConsent(tester);

    expect(find.text(EmployerSharingNotice.heading), findsOneWidget);
    await tester.scrollUntilVisible(
      find.text('Aapki awaaz record karne ki ijaazat'),
      120,
      scrollable: find.byType(Scrollable).first,
    );
    expect(find.text('Aapki awaaz record karne ki ijaazat'), findsOneWidget);
    expect(find.text('I agree'), findsOneWidget);
  });

  test('the line ships with no consent-version change', () {
    // A notice change must bump the version in the same change; this line is
    // not notice text, so the version stays the approved notice's.
    expect(kConsentVersion, '2026-11-04');
  });

  test('the line is neutral copy: no price, no amount', () {
    expect(kFreeForWorkersText, isNot(contains('₹')));
    expect(kFreeForWorkersText, isNot(matches(RegExp(r'\d'))));
  });

  group('switched on, on every device size and system font', () {
    setUp(switchOn);

    kitMatrixTest(
      'the sign-up screen with the free line',
      () => const ConsentScreen(),
      primary: () => find.text(kFreeForWorkersText),
    );
  });
}
