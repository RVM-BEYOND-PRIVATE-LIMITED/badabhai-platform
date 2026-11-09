import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';

import 'package:payer_app/app.dart';
import 'package:payer_app/core/data/mock_payer_api_client.dart';
import 'package:payer_app/core/di/locator.dart';
import 'package:payer_app/core/session/app_session.dart';
import 'package:payer_app/core/session/app_session_cubit.dart';

/// As-built screenshots of the payer app in mock mode, signed in.
///
///   flutter test integration_test/screenshots_payer_test.dart \
///     -d emulator-5554 --dart-define=USE_MOCKS=true
void main() {
  Future<void> settle(WidgetTester tester,
      {Duration first = const Duration(milliseconds: 400)}) async {
    await tester.pump();
    await tester.pump(first);
    await tester.pump(const Duration(milliseconds: 900));
  }

  setUp(() async {
    GoogleFonts.config.allowRuntimeFetching = false;
    await locator.reset();
    setupLocator(apiClient: MockPayerApiClient());
  });

  tearDown(() => locator.reset());

  testWidgets('payer app screenshots (signed in)', (WidgetTester tester) async {
    tester.view.physicalSize = const Size(1080, 2400);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);

    locator<AppSessionCubit>().signIn(PayerRole.company);
    final GlobalKey boundaryKey = GlobalKey();
    await tester.pumpWidget(
      RepaintBoundary(
        key: boundaryKey,
        child: const PayerApp(),
      ),
    );
    await settle(tester, first: const Duration(milliseconds: 1400));

    final Directory outDir =
        Directory('${Directory.systemTemp.path}/screenshots-payer');
    await outDir.create(recursive: true);

    Future<void> capture(String name) async {
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 500));
      while (tester.takeException() != null) {}
      final RenderRepaintBoundary boundary =
          boundaryKey.currentContext!.findRenderObject()!
              as RenderRepaintBoundary;
      final ui.Image image = await boundary.toImage(pixelRatio: 1.0);
      final ByteData? data =
          await image.toByteData(format: ui.ImageByteFormat.png);
      image.dispose();
      if (data == null) return;
      await File('${outDir.path}/$name.png')
          .writeAsBytes(data.buffer.asUint8List(), flush: true);
      // ignore: avoid_print
      print('CAPTURED $name');
    }

    Future<void> tapText(String text) async {
      final Finder f = find.text(text);
      if (f.evaluate().isEmpty) throw StateError('text not found: $text');
      await tester.tap(f.last);
      await settle(tester);
    }

    Future<void> backAny() async {
      final Finder sem = find.bySemanticsLabel('Back');
      if (sem.evaluate().isNotEmpty) {
        await tester.tap(sem.first);
        await settle(tester);
        return;
      }
      final Finder icon = find.byIcon(Icons.arrow_back_rounded);
      if (icon.evaluate().isNotEmpty) {
        await tester.tap(icon.first);
        await settle(tester);
        return;
      }
      final Finder icon2 = find.byIcon(Icons.arrow_back);
      if (icon2.evaluate().isNotEmpty) {
        await tester.tap(icon2.first);
        await settle(tester);
        return;
      }
      await tester.pageBack();
      await settle(tester);
    }

    Future<void> pageBack() => backAny();
    Future<void> backIcon() => backAny();

    await capture('payer_03_home_company');

    try {
      await tapText('Find');
      await capture('payer_04_find_all');
      await tapText('History');
      await capture('payer_05_disclosure_history');
      await pageBack();
      await tester.tap(find.byKey(const Key('find_view_applicants')));
      await settle(tester);
      await capture('payer_06_find_applicants');
      await tester.tap(find.byKey(const Key('find_view_all')));
      await settle(tester);
      final Finder unlock = find.text('Unlock');
      if (unlock.evaluate().isNotEmpty) {
        await tester.tap(unlock.first);
        await settle(tester);
        final Finder confirm = find.text('Unlock for 1 credit');
        if (confirm.evaluate().isNotEmpty) {
          await tester.tap(confirm.first);
          await settle(tester, first: const Duration(milliseconds: 1200));
          await capture('payer_07_reveal');
          await backIcon();
        }
      }
    } catch (error) {
      // ignore: avoid_print
      print('find flow skipped: $error');
    }

    try {
      await tapText('Jobs');
      await capture('payer_08_jobs_company');
      try {
        await tapText('Create with AI');
        await capture('payer_09_ai_chat');
        await backIcon();
      } catch (error) {
        // ignore: avoid_print
        print('AI chat skipped: $error');
      }
      final Finder more = find.byIcon(Icons.more_horiz_rounded);
      if (more.evaluate().isNotEmpty) {
        await tester.tap(more.first);
        await settle(tester);
        try {
          await tapText('Edit details');
          await capture('payer_10_edit_company_job');
          await pageBack();
        } catch (error) {
          // ignore: avoid_print
          print('company edit skipped: $error');
        }
      }
    } catch (error) {
      // ignore: avoid_print
      print('jobs flow skipped: $error');
    }

    try {
      await tapText('Home');
      await tapText('Post a job');
      await capture('payer_11_post_job');
      await backIcon();
    } catch (error) {
      // ignore: avoid_print
      print('post job skipped: $error');
    }

    try {
      await tapText('Credits');
      await capture('payer_12_credits');
    } catch (error) {
      // ignore: avoid_print
      print('credits skipped: $error');
    }

    try {
      await tapText('Account');
      await capture('payer_13_account');
      await tapText('Team');
      await capture('payer_14_team');
      await pageBack();
      await tapText('Hiring capacity');
      await capture('payer_15_capacity');
      await pageBack();
    } catch (error) {
      // ignore: avoid_print
      print('account flow skipped: $error');
    }

    try {
      await locator<AppSessionCubit>().signOut();
      await settle(tester);
      locator<AppSessionCubit>().signIn(PayerRole.agency);
      await settle(tester, first: const Duration(milliseconds: 1200));
      await capture('payer_16_home_agency');
      await tapText('Jobs');
      await capture('payer_17_jobs_agency');
      final Finder more = find.byIcon(Icons.more_horiz_rounded);
      if (more.evaluate().isNotEmpty) {
        await tester.tap(more.first);
        await settle(tester);
        try {
          await tapText('Edit details');
          await capture('payer_18_edit_agency_job');
          await pageBack();
        } catch (error) {
          // ignore: avoid_print
          print('agency edit skipped: $error');
        }
      }
      await tapText('Home');
      await tapText('Refer & earn');
      await capture('payer_19_referral');
      await tapText('Referred workers');
      await capture('payer_20_agency_engagement');
      await pageBack();
      await tester.scrollUntilVisible(
        find.text('Invite in bulk'),
        350,
        scrollable: find.byType(Scrollable).last,
      );
      await settle(tester);
      await tapText('Invite in bulk');
      await capture('payer_21_batch_invite');
    } catch (error) {
      // ignore: avoid_print
      print('agency flow skipped: $error');
    }

    // ignore: avoid_print
    print('PAYER_SCREENSHOTS_READY ${outDir.path}');
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(seconds: 240)),
    );
  });
}
