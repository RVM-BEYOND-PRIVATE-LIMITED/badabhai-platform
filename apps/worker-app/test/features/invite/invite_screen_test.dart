import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/widgets/onboarding/primary_action_button.dart';
import 'package:badabhai_worker_app/features/invite/domain/invite_repository.dart';
import 'package:badabhai_worker_app/features/invite/presentation/cubit/invite_cubit.dart';
import 'package:badabhai_worker_app/features/invite/presentation/invite_screen.dart';

import '../../support/kit_matrix.dart';

class _MockInviteRepository extends Mock implements InviteRepository {}

const InviteLink _link = InviteLink(
  code: 'abc',
  url: 'https://app.badabhai.in/i/abc',
);

/// The screen had NO widget test, only cubit tests — so nothing pinned that the
/// two share buttons are actually wired to the two DIFFERENT cubit paths, or
/// that a refused clipboard is reported honestly.
void main() {
  late _MockInviteRepository repo;
  late List<String> shared;
  late List<Uri> launched;
  late List<String> copied;
  late bool launchSucceeds;
  late bool clipboardRefuses;

  setUp(() async {
    repo = _MockInviteRepository();
    shared = <String>[];
    launched = <Uri>[];
    copied = <String>[];
    launchSucceeds = true;
    clipboardRefuses = false;
    when(
      () => repo.createInvite(campaign: any(named: 'campaign')),
    ).thenAnswer((_) async => _link);

    await locator.reset();
    locator.registerFactory<InviteCubit>(
      () => InviteCubit(
        repo,
        share: (String text) async => shared.add(text),
        launch: (Uri url) async {
          launched.add(url);
          return launchSucceeds;
        },
        copy: (String text) async {
          if (clipboardRefuses) throw Exception('clipboard refused');
          copied.add(text);
        },
      ),
    );
  });

  tearDown(() async => locator.reset());

  Future<void> pump(WidgetTester tester) async {
    await tester.pumpWidget(kitTestApp(const InviteScreen()));
    await tester.pump(); // createInvite resolves
  }

  testWidgets(
    'the ready screen shows the header, the real link and both CTAs',
    (WidgetTester tester) async {
      await pump(tester);

      expect(find.text('Dost ko invite karein'), findsOneWidget);
      expect(find.text('Referral link share karein'), findsOneWidget);
      expect(find.byTooltip('Wapas'), findsOneWidget);
      expect(find.text(_link.url), findsOneWidget);
      expect(find.text('Link share karein'), findsOneWidget);
      expect(find.text('WhatsApp pe bhejein'), findsOneWidget);
      // The opaque code is not a worker-facing string on its own (D11) — the
      // shareable URL is.
      expect(find.text('abc'), findsNothing);
    },
  );

  testWidgets('the yellow CTA hands the link to the share sheet', (
    WidgetTester tester,
  ) async {
    await pump(tester);

    await tester.tap(find.text('Link share karein'));
    await tester.pump();

    expect(shared, hasLength(1));
    expect(shared.single, contains(_link.url));
    expect(launched, isEmpty);
  });

  testWidgets('the green CTA opens WhatsApp itself — not the generic sheet', (
    WidgetTester tester,
  ) async {
    await pump(tester);

    await tester.tap(find.text('WhatsApp pe bhejein'));
    await tester.pump();

    expect(launched, hasLength(1));
    expect(launched.single.host, 'wa.me');
    expect(launched.single.queryParameters['text'], contains(_link.url));
    expect(shared, isEmpty);
  });

  testWidgets('a device without WhatsApp still gets to send: sheet fallback', (
    WidgetTester tester,
  ) async {
    launchSucceeds = false;
    await pump(tester);

    await tester.tap(find.text('WhatsApp pe bhejein'));
    await tester.pump();

    expect(launched, hasLength(1));
    expect(shared, hasLength(1), reason: 'the button must never dead-end');
  });

  testWidgets('copy confirms only what the clipboard actually took', (
    WidgetTester tester,
  ) async {
    await pump(tester);

    await tester.tap(find.byTooltip('Link copy karein'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(copied, <String>[_link.url]);
    expect(find.text('Link copy ho gaya'), findsOneWidget);
  });

  testWidgets('a refused clipboard says so instead of claiming success', (
    WidgetTester tester,
  ) async {
    clipboardRefuses = true;
    await pump(tester);

    await tester.tap(find.byTooltip('Link copy karein'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(copied, isEmpty);
    expect(find.text('Link copy nahi ho paya'), findsOneWidget);
    expect(find.text('Link copy ho gaya'), findsNothing);
  });

  testWidgets('a failed create shows the honest reason and retries', (
    WidgetTester tester,
  ) async {
    when(
      () => repo.createInvite(campaign: any(named: 'campaign')),
    ).thenThrow(const NetworkFailure());

    await pump(tester);

    expect(find.text('Invite link nahi bani.'), findsOneWidget);
    expect(find.text('Dobara try karein'), findsOneWidget);

    when(
      () => repo.createInvite(campaign: any(named: 'campaign')),
    ).thenAnswer((_) async => _link);
    await tester.tap(find.text('Dobara try karein'));
    await tester.pump();
    await tester.pump();

    expect(find.text(_link.url), findsOneWidget);
  });

  testWidgets('at 768 the content column stops instead of stretching', (
    WidgetTester tester,
  ) async {
    setKitSurface(tester, const Size(768, 1024));
    await tester.pumpWidget(kitTestApp(const InviteScreen()));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(
      widthOf(tester, find.byType(PrimaryActionButton)),
      lessThanOrEqualTo(440),
    );
  });

  testWidgets('every control clears the 48dp touch floor', (
    WidgetTester tester,
  ) async {
    setKitSurface(tester, const Size(360, 640));
    await tester.pumpWidget(kitTestApp(const InviteScreen()));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    await expectKitTapTargets(tester);
  });

  group('matrix', () {
    kitMatrixTest(
      'invite ready',
      () => const InviteScreen(),
      primary: () => find.text('Link share karein'),
    );
  });
}
