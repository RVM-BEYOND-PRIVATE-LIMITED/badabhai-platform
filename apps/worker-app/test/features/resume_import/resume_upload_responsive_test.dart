import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/theme/onboarding_theme.dart';
import 'package:badabhai_worker_app/features/resume_import/domain/resume_document.dart';
import 'package:badabhai_worker_app/features/resume_import/domain/resume_document_picker.dart';
import 'package:badabhai_worker_app/features/resume_import/domain/resume_importer.dart';
import 'package:badabhai_worker_app/features/resume_import/presentation/resume_upload_screen.dart';
import 'package:badabhai_worker_app/features/resume_import/presentation/widgets/resume_door_tile.dart';

import '../../support/kit_matrix.dart';

/// Neither seam is touched by any test here — this file is about the drawing,
/// and doors 2 and 3 must issue no request at all (`resume_upload_screen_test`
/// pins that with a recording client).
class _IdlePicker implements ResumeDocumentPicker {
  @override
  Future<ResumePickResult> pickResume() async => ResumePickResult.picked(
    PickedResumeDocument(kind: ResumeDocumentKind.pdf, bytes: Uint8List(8)),
  );
}

class _IdleImporter implements ResumeImporter {
  @override
  Future<ResumeImportOutcome> importResume(PickedResumeDocument d) async =>
      const ResumeImportRoutedToChat();
}

/// The three doors (spec §3.7) on every device a worker owns.
///
/// Each door is a two-line card, and the three of them plus a header subtitle
/// and the floating-pill clearance are what has to fit — at 200% system font on
/// a 320dp handset it only fits because the body scrolls.
void main() {
  setUp(() async {
    await locator.reset();
    locator.registerLazySingleton<ResumeDocumentPicker>(() => _IdlePicker());
    locator.registerLazySingleton<ResumeImporter>(() => _IdleImporter());
  });

  tearDown(() => locator.reset());

  Widget screen() => const ResumeUploadScreen();

  kitMatrixTest(
    'resume doors — no overflow, the upload door present',
    screen,
    primary: () => find.text('Resume upload karein'),
  );

  testWidgets('768x1024 caps the doors at 440 (R13)', (
    WidgetTester tester,
  ) async {
    setKitSurface(tester, const Size(768, 1024));
    await tester.pumpWidget(kitTestApp(screen()));
    await tester.pump();

    expect(
      widthOf(tester, find.byType(ResumeDoorTile).first),
      lessThanOrEqualTo(OnboardingLayout.maxContentWidth),
    );
  });

  testWidgets('every door clears the touch floor at 360x640 @1.0', (
    WidgetTester tester,
  ) async {
    final SemanticsHandle handle = tester.ensureSemantics();
    setKitSurface(tester, const Size(360, 640));
    await tester.pumpWidget(kitTestApp(screen()));
    await tester.pump();

    await expectKitTapTargets(tester);
    handle.dispose();
  });

  group('spec values', () {
    testWidgets('three doors, exactly ONE yellow hero, in the spec order', (
      WidgetTester tester,
    ) async {
      setKitSurface(tester, const Size(390, 844));
      await tester.pumpWidget(kitTestApp(screen()));
      await tester.pump();

      final List<ResumeDoorTile> doors = tester
          .widgetList<ResumeDoorTile>(find.byType(ResumeDoorTile))
          .toList();
      expect(doors.length, 3);
      expect(doors[0].title, 'Resume upload karein');
      expect(doors[1].title, 'Hinglish mein baat karein');
      expect(doors[2].title, 'Mere paas resume nahi hai');

      // One yellow surface per screen: the upload door, and only it.
      expect(doors.where((ResumeDoorTile d) => d.emphasis).length, 1);
      expect(doors[0].emphasis, isTrue);

      // The v3 rounded glyphs (spec §3.7: document / chat / minus-circle).
      expect(doors[0].icon, Icons.upload_file_outlined);
      expect(doors[1].icon, Icons.chat_bubble_outline_rounded);
      expect(doors[2].icon, Icons.do_not_disturb_on_outlined);
    });

    testWidgets('a door is a flat card — fill + hairline, never a shadow', (
      WidgetTester tester,
    ) async {
      setKitSurface(tester, const Size(390, 844));
      await tester.pumpWidget(kitTestApp(screen()));
      await tester.pump();

      final Material hero = tester.widget<Material>(
        find
            .descendant(
              of: find.byType(ResumeDoorTile).first,
              matching: find.byType(Material),
            )
            .first,
      );
      expect(hero.elevation, 0);
      expect(hero.color, OnboardingColors.safetyYellow);

      final BoxDecoration frame =
          tester
                  .widget<Container>(
                    find
                        .descendant(
                          of: find.byType(ResumeDoorTile).first,
                          matching: find.byType(Container),
                        )
                        .first,
                  )
                  .decoration!
              as BoxDecoration;
      expect(frame.boxShadow, anyOf(isNull, isEmpty));
    });

    testWidgets('nothing on screen is a raw id, slug or enum (D11)', (
      WidgetTester tester,
    ) async {
      setKitSurface(tester, const Size(390, 844));
      await tester.pumpWidget(kitTestApp(screen()));
      await tester.pump();

      // The server's `failure_reason` vocabulary (`ocr_below_floor`,
      // `uploads_unavailable`, …) is never worker-facing: a worker cannot act
      // on a machine cause. Any snake_case token in rendered copy is one.
      final RegExp token = RegExp(r'\b[a-z0-9]+_[a-z0-9_]+\b');
      for (final Text text in tester.widgetList<Text>(find.byType(Text))) {
        final String? data = text.data;
        if (data == null) continue;
        expect(
          token.hasMatch(data),
          isFalse,
          reason: 'raw token on screen: "$data"',
        );
      }
    });
  });
}
