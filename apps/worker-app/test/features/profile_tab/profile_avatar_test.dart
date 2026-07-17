import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/nav/tab_focus.dart';
import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/features/profile_tab/presentation/widgets/profile_avatar.dart';
import 'package:badabhai_worker_app/features/resume/domain/photo_repository.dart';

class _MockPhotoRepository extends Mock implements PhotoRepository {}

/// ADR-0032 B2 — the Profile tab is the SECOND entry point to the one photo per
/// worker. It used to render initials only, with the photo flow reachable solely
/// from the resume-edit screen.
void main() {
  late _MockPhotoRepository photos;
  late TabFocus tabFocus;

  setUp(() async {
    await locator.reset();
    photos = _MockPhotoRepository();
    tabFocus = TabFocus();
    registerFallbackValue(Uint8List(0));
    locator.registerSingleton<PhotoRepository>(photos);
    locator.registerSingleton<TabFocus>(tabFocus);
  });

  tearDown(() async {
    tabFocus.dispose();
    await locator.reset();
  });

  Future<void> pump(WidgetTester tester, {String? initials = 'RO'}) async {
    GoogleFonts.config.allowRuntimeFetching = false;
    await tester.pumpWidget(MaterialApp(
      theme: AppTheme.light(),
      home: Scaffold(
        body: ProfileAvatar(initials: initials, verified: false),
      ),
    ));
    await tester.pump(); // photoUrl() resolves
  }

  testWidgets('renders the photo when the worker has one', (
    WidgetTester tester,
  ) async {
    when(() => photos.photoUrl())
        .thenAnswer((_) async => 'https://signed.example/photo.jpg');

    await pump(tester);

    final Image img = tester.widget<Image>(find.byType(Image));
    expect((img.image as NetworkImage).url, 'https://signed.example/photo.jpg');
    // The placeholder is gone — the worker sees their own face.
    expect(find.byIcon(Icons.person_rounded), findsNothing);
  });

  testWidgets('404 (no photo) → the existing placeholder, not an error', (
    WidgetTester tester,
  ) async {
    // The repository maps 404 → null: "no photo yet" is not a failure.
    when(() => photos.photoUrl()).thenAnswer((_) async => null);

    await pump(tester, initials: null);

    expect(find.byIcon(Icons.person_rounded), findsOneWidget);
    expect(find.byType(Image), findsNothing);
  });

  testWidgets('falls back to initials when there is no photo and a name exists',
      (WidgetTester tester) async {
    when(() => photos.photoUrl()).thenAnswer((_) async => null);

    await pump(tester);

    expect(find.text('RO'), findsOneWidget);
  });

  testWidgets('a fetch FAILURE is silent — the tab never breaks', (
    WidgetTester tester,
  ) async {
    // 503 photos-dormant is the realistic case; any failure must degrade the
    // same way. The Profile tab is the worker's identity screen — a photo hiccup
    // must not cost them their profile.
    when(() => photos.photoUrl()).thenThrow(const PhotoUnavailableFailure());

    await pump(tester);

    expect(tester.takeException(), isNull);
    expect(find.text('RO'), findsOneWidget);
  });

  testWidgets('the edit badge opens the SHARED sheet', (
    WidgetTester tester,
  ) async {
    when(() => photos.photoUrl()).thenAnswer((_) async => null);

    await pump(tester);
    await tester.tap(find.bySemanticsLabel('Photo lagayein'));
    await tester.pumpAndSettle();

    // The same sheet the resume-edit screen shows — one flow, one wording.
    expect(find.text('Photo khichein'), findsOneWidget);
    expect(find.text('Gallery se chunein'), findsOneWidget);
    // Nothing to remove yet, so the option is absent.
    expect(find.text('Photo hatayein'), findsNothing);
  });

  testWidgets('the sheet offers REMOVE only when a photo exists', (
    WidgetTester tester,
  ) async {
    when(() => photos.photoUrl())
        .thenAnswer((_) async => 'https://signed.example/photo.jpg');

    await pump(tester);
    await tester.tap(find.bySemanticsLabel('Photo badlein'));
    await tester.pumpAndSettle();

    expect(find.text('Photo hatayein'), findsOneWidget);
  });

  testWidgets('remove re-fetches so the tab shows the new truth', (
    WidgetTester tester,
  ) async {
    int calls = 0;
    when(() => photos.photoUrl()).thenAnswer((_) async {
      calls++;
      return calls == 1 ? 'https://signed.example/photo.jpg' : null;
    });
    when(() => photos.removePhoto()).thenAnswer((_) async {});

    await pump(tester);
    await tester.tap(find.bySemanticsLabel('Photo badlein'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Photo hatayein'));
    await tester.pumpAndSettle();

    verify(() => photos.removePhoto()).called(1);
    expect(calls, 2, reason: 'the avatar re-reads after a change');
    expect(find.text('RO'), findsOneWidget, reason: 'photo gone → placeholder');
  });

  testWidgets('a failed CHANGE is surfaced honestly (unlike a failed read)', (
    WidgetTester tester,
  ) async {
    when(() => photos.photoUrl())
        .thenAnswer((_) async => 'https://signed.example/photo.jpg');
    // The worker ASKED for this, so silence would be wrong.
    when(() => photos.removePhoto()).thenThrow(const PhotoUnavailableFailure());

    await pump(tester);
    await tester.tap(find.bySemanticsLabel('Photo badlein'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Photo hatayein'));
    await tester.pumpAndSettle();

    // Honest typed copy, never a raw error string.
    expect(find.byType(SnackBar), findsOneWidget);
  });

  testWidgets('the edit tap target is at least 44dp', (
    WidgetTester tester,
  ) async {
    when(() => photos.photoUrl()).thenAnswer((_) async => null);

    await pump(tester);

    final Size size = tester.getSize(find.bySemanticsLabel('Photo lagayein'));
    expect(size.width, greaterThanOrEqualTo(44));
    expect(size.height, greaterThanOrEqualTo(44));
  });

  testWidgets('re-fetches when the Profile tab regains focus (B3)', (
    WidgetTester tester,
  ) async {
    when(() => photos.photoUrl()).thenAnswer((_) async => null);
    await pump(tester);
    clearInteractions(photos);

    // A photo changed on the resume-edit screen; the shell keeps this branch
    // mounted, so without the focus hook the tab would never notice.
    tabFocus.value = TabIndex.jobs;
    tabFocus.value = TabIndex.profile;
    await tester.pump();

    verify(() => photos.photoUrl()).called(1);
  });
}
