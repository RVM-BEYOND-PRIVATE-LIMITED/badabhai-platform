import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';

import 'package:payer_app/core/data/mock_payer_api_client.dart';
import 'package:payer_app/core/data/models.dart';
import 'package:payer_app/core/di/locator.dart';
import 'package:payer_app/core/theme/app_theme.dart';
import 'package:payer_app/features/agency/presentation/batch_invite_screen.dart';
import 'package:payer_app/features/jobs/presentation/cubit/agency_jobs_cubit.dart';
import 'package:payer_app/features/jobs/presentation/cubit/jobs_cubit.dart';
import 'package:payer_app/features/jobs/presentation/edit_agency_job_screen.dart';
import 'package:payer_app/features/jobs/presentation/edit_company_job_screen.dart';

/// Screens that are only reachable behind a scrolled menu in the shell walk:
/// batch invites and the two edit-job forms.
void main() {
  setUp(() async {
    GoogleFonts.config.allowRuntimeFetching = false;
    await locator.reset();
  });

  tearDown(() => locator.reset());

  testWidgets('payer extra screenshots', (WidgetTester tester) async {
    tester.view.physicalSize = const Size(1080, 2400);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);

    final MockPayerApiClient api = MockPayerApiClient();
    setupLocator(apiClient: api);
    final List<JobPosting> jobs = await api.fetchJobs();
    final List<AgencyJobView> agencyJobs = await api.fetchAgencyJobs();

    final Directory outDir =
        Directory('${Directory.systemTemp.path}/screenshots-payer-extra');
    await outDir.create(recursive: true);

    Future<void> shot(GlobalKey key, String name, Widget home) async {
      await tester.pumpWidget(
        RepaintBoundary(
          key: key,
          child: MaterialApp(
            theme: AppTheme.light(),
            debugShowCheckedModeBanner: false,
            home: home,
          ),
        ),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 900));
      while (tester.takeException() != null) {}
      final RenderRepaintBoundary boundary =
          key.currentContext!.findRenderObject()! as RenderRepaintBoundary;
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

    await shot(
      GlobalKey(),
      'payer_21_batch_invite',
      const BatchInviteScreen(),
    );

    final JobsCubit jobsCubit = JobsCubit(api);
    await shot(
      GlobalKey(),
      'payer_10_edit_company_job',
      EditCompanyJobScreen(job: jobs.first, cubit: jobsCubit),
    );

    final AgencyJobsCubit agencyCubit = AgencyJobsCubit(api);
    await shot(
      GlobalKey(),
      'payer_18_edit_agency_job',
      EditAgencyJobScreen(job: agencyJobs.first, cubit: agencyCubit),
    );

    // ignore: avoid_print
    print('PAYER_EXTRA_SCREENSHOTS_READY ${outDir.path}');
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(seconds: 120)),
    );
  });
}
