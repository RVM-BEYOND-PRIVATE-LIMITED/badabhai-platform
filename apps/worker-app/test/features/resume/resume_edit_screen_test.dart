import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/features/resume/domain/photo_repository.dart';
import 'package:badabhai_worker_app/features/resume/domain/resume_edit_repository.dart';
import 'package:badabhai_worker_app/features/resume/domain/resume_safe_fields.dart';
import 'package:badabhai_worker_app/features/resume/presentation/cubit/resume_edit_cubit.dart';
import 'package:badabhai_worker_app/features/resume/presentation/resume_edit_screen.dart';

class MockResumeEditRepository extends Mock implements ResumeEditRepository {}

class MockPhotoRepository extends Mock implements PhotoRepository {}

const ResumeSafeFields _fields = ResumeSafeFields(
  displayName: 'Ramesh Kumar',
  showPhoto: true,
  nightShiftReady: false,
);

/// Pumps the screen in its loaded `ready` state. [saveThrows], when given, makes
/// `save()` reject with it — covering both the typed-[Failure] path and an
/// UNMAPPED escape (the catch-all).
Future<MockResumeEditRepository> _pump(
  WidgetTester tester, {
  Object? saveThrows,
}) async {
  GoogleFonts.config.allowRuntimeFetching = false;
  await locator.reset();
  final MockResumeEditRepository repo = MockResumeEditRepository();
  registerFallbackValue(_fields);
  when(() => repo.load()).thenAnswer((_) async => _fields);
  if (saveThrows == null) {
    when(() => repo.save(any())).thenAnswer((_) async => false);
  } else {
    when(() => repo.save(any())).thenThrow(saveThrows);
  }
  final MockPhotoRepository photos = MockPhotoRepository();
  when(() => photos.photoUrl()).thenAnswer((_) async => null);
  locator.registerFactory<ResumeEditCubit>(() => ResumeEditCubit(repo, photos));

  tester.view.physicalSize = const Size(900, 1900);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);

  await tester.pumpWidget(
    MaterialApp(theme: AppTheme.light(), home: const ResumeEditScreen()),
  );
  await tester.pump(); // loading
  await tester.pump(); // load() resolves -> ready
  return repo;
}

void main() {
  tearDown(() async => locator.reset());

  testWidgets('renders the editable fields once loaded', (
    WidgetTester tester,
  ) async {
    await _pump(tester);
    expect(find.text('Naam ki spelling'), findsOneWidget);
    expect(find.text('Ramesh Kumar'), findsOneWidget);
    expect(find.text('Save karein'), findsOneWidget);
    // ADR-0032: the photo row exists with the add affordance (no photo yet).
    expect(find.text('Aapki photo'), findsOneWidget);
    expect(find.text('Photo add karein'), findsOneWidget);
    expect(find.byIcon(Icons.add_a_photo_outlined), findsOneWidget);
  });

  testWidgets(
      'ADR-0032: tapping the photo row opens the camera/gallery sheet (no Remove without a photo)',
      (WidgetTester tester) async {
    await _pump(tester);

    await tester.tap(find.byIcon(Icons.add_a_photo_outlined));
    await tester.pumpAndSettle();

    expect(find.text('Photo khichein'), findsOneWidget);
    expect(find.text('Gallery se chunein'), findsOneWidget);
    expect(find.text('Photo hatayein'), findsNothing); // no photo → no remove

    // Dismiss without picking — nothing crashes, nothing uploads.
    await tester.tapAt(const Offset(10, 10));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
  });

  // REGRESSION: the name dialog used to be built with a controller owned by the
  // AWAITING CALLER, which disposed it immediately after `showDialog` resolved.
  // showDialog's future completes at POP time — while the route is still mounted
  // and animating out — so the still-live TextField was left holding a disposed
  // controller and the app crashed with "A TextEditingController was used after
  // being disposed". pumpAndSettle drives that exit transition, so this test
  // FAILS on the old code and passes now that the dialog owns its controller.
  testWidgets(
      'editing the name via the dialog does not crash while the dialog animates out',
      (WidgetTester tester) async {
    await _pump(tester);

    await tester.tap(find.byIcon(Icons.edit_outlined));
    await tester.pumpAndSettle();
    expect(find.byType(TextField), findsOneWidget);

    await tester.enterText(find.byType(TextField), 'Ramesh Kumaar');
    await tester.tap(find.text('OK'));
    // Runs the dialog's REVERSE transition to completion — the exact window in
    // which the disposed controller was touched.
    await tester.pumpAndSettle();

    expect(tester.takeException(), isNull);
    expect(find.text('Ramesh Kumaar'), findsOneWidget);
  });

  testWidgets('cancelling the name dialog leaves the spelling untouched', (
    WidgetTester tester,
  ) async {
    await _pump(tester);

    await tester.tap(find.byIcon(Icons.edit_outlined));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), 'Discarded');
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();

    expect(tester.takeException(), isNull);
    expect(find.text('Ramesh Kumar'), findsOneWidget);
    expect(find.text('Discarded'), findsNothing);
  });

  testWidgets('a failed save shows an honest snackbar instead of crashing', (
    WidgetTester tester,
  ) async {
    await _pump(tester, saveThrows: const NetworkFailure());

    await tester.tap(find.text('Save karein'));
    await tester.pump(); // saving
    await tester.pump(); // save() rejects -> saveErrorNonce bumps
    await tester.pump(); // snackbar frame

    expect(tester.takeException(), isNull);
    expect(
      find.text('Server se connect nahi ho pa raha. Dobara try karein.'),
      findsOneWidget,
    );
  });

  // The screen wires `onPressed: cubit.save`, DISCARDING the Future — so an
  // error the repository failed to map to a [Failure] has no handler and would
  // reach the zone unhandled. save()'s catch-all must degrade it to a snackbar.
  testWidgets('an UNMAPPED save error degrades to a snackbar, never a crash', (
    WidgetTester tester,
  ) async {
    await _pump(tester, saveThrows: Exception('unmapped boom'));

    await tester.tap(find.text('Save karein'));
    await tester.pump();
    await tester.pump();
    await tester.pump();

    expect(tester.takeException(), isNull);
    expect(find.text('Kuch gadbad ho gayi. Dobara try karein.'), findsOneWidget);
  });

  // mapError is total: an unmapped TRANSPORT error still reads honestly rather
  // than collapsing to the generic line.
  testWidgets('an unmapped transport error still degrades honestly', (
    WidgetTester tester,
  ) async {
    await _pump(tester, saveThrows: const SocketException('connection refused'));

    await tester.tap(find.text('Save karein'));
    await tester.pump();
    await tester.pump();
    await tester.pump();

    expect(tester.takeException(), isNull);
    expect(
      find.text('Server se connect nahi ho pa raha. Dobara try karein.'),
      findsOneWidget,
    );
  });
}
