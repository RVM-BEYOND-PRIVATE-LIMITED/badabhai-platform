// The feedback screen's image-attachment flow: pick (up to 3) from a Camera /
// Gallery chooser, thumbnail + remove, and a submit that uploads best-effort so
// the TEXT feedback ALWAYS sends even when every image drops.
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart' show ApiException;
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/features/feedback/domain/feedback_attachment_uploader.dart';
import 'package:badabhai_worker_app/features/feedback/domain/feedback_category.dart';
import 'package:badabhai_worker_app/features/feedback/domain/feedback_image_picker.dart';
import 'package:badabhai_worker_app/features/feedback/domain/feedback_repository.dart';
import 'package:badabhai_worker_app/features/feedback/presentation/feedback_screen.dart';

class _MockFeedbackRepository extends Mock implements FeedbackRepository {}

/// Returns canned bytes for every pick (or null to model a cancel).
class _FakePicker implements FeedbackImagePicker {
  _FakePicker({this.bytes});
  final Uint8List? bytes;
  int calls = 0;

  @override
  Future<Uint8List?> pick(FeedbackImageSource source) async {
    calls++;
    return bytes;
  }
}

/// Records each upload; returns a distinct path per call, or throws when [fail]
/// (a dormant bucket / undeployed endpoint) — the exact case the screen swallows.
class _FakeUploader implements FeedbackAttachmentUploader {
  _FakeUploader({this.fail = false});
  final bool fail;
  final List<Uint8List> uploaded = <Uint8List>[];

  @override
  Future<String> upload(Uint8List bytes) async {
    uploaded.add(bytes);
    if (fail) throw ApiException(503, 'dormant');
    return 'feedback-attachments/w1/img-${uploaded.length - 1}.jpg';
  }
}

void main() {
  late _MockFeedbackRepository repo;

  setUpAll(() {
    registerFallbackValue(FeedbackCategory.other);
    registerFallbackValue(<String>[]);
  });

  // A few bytes are enough — the Image widget mounts regardless of decode, and
  // the thumbnail carries an errorBuilder so undecodable bytes never throw.
  final Uint8List sampleBytes = Uint8List.fromList(<int>[0x89, 0x50, 0x4E, 0x47]);

  void wire({_FakePicker? picker, _FakeUploader? uploader}) {
    repo = _MockFeedbackRepository();
    locator
      ..registerFactory<FeedbackRepository>(() => repo)
      ..registerFactory<FeedbackImagePicker>(
          () => picker ?? _FakePicker(bytes: Uint8List.fromList(<int>[1, 2, 3])))
      ..registerFactory<FeedbackAttachmentUploader>(
          () => uploader ?? _FakeUploader());
  }

  setUp(() => locator.reset());
  tearDown(() => locator.reset());

  Future<GoRouter> pump(WidgetTester tester) async {
    final GoRouter router = GoRouter(
      initialLocation: '/home',
      routes: <RouteBase>[
        GoRoute(
          path: '/home',
          builder: (_, __) => Scaffold(
            body: Builder(
              builder: (BuildContext c) => TextButton(
                onPressed: () => c.push('/feedback'),
                child: const Text('OPEN'),
              ),
            ),
          ),
        ),
        GoRoute(path: '/feedback', builder: (_, __) => const FeedbackScreen()),
      ],
    );
    await tester.pumpWidget(
        MaterialApp.router(theme: AppTheme.light(), routerConfig: router));
    await tester.tap(find.text('OPEN'));
    await tester.pumpAndSettle();
    return router;
  }

  /// Tap "add photo" → chooser → Gallery. Scrolls the add control into view
  /// first (the screen is a long scroller on a small viewport).
  Future<void> addOneImage(WidgetTester tester) async {
    await tester.ensureVisible(find.byKey(kFeedbackAddImageKey));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(kFeedbackAddImageKey));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Gallery'));
    await tester.pumpAndSettle();
  }

  testWidgets('pick up to 3 — thumbnail + remove work, add hides at the cap',
      (WidgetTester tester) async {
    wire();
    await pump(tester);

    // Nothing attached yet: add control present, no strip.
    expect(find.byKey(kFeedbackAddImageKey), findsOneWidget);
    expect(find.byKey(kFeedbackImageStripKey), findsNothing);

    await addOneImage(tester);
    expect(find.byKey(kFeedbackImageStripKey), findsOneWidget);
    expect(find.byKey(feedbackRemoveImageKey(0)), findsOneWidget);
    expect(find.byKey(feedbackRemoveImageKey(1)), findsNothing);
    expect(find.byKey(kFeedbackAddImageKey), findsOneWidget);

    await addOneImage(tester);
    await addOneImage(tester);
    // Three attached → the add control is GONE (a fourth the server rejects is
    // now unpickable).
    expect(find.byKey(feedbackRemoveImageKey(2)), findsOneWidget);
    expect(find.byKey(kFeedbackAddImageKey), findsNothing);

    // Remove the first → back to two, add control returns.
    await tester.ensureVisible(find.byKey(feedbackRemoveImageKey(0)));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(feedbackRemoveImageKey(0)));
    await tester.pumpAndSettle();
    expect(find.byKey(feedbackRemoveImageKey(2)), findsNothing);
    expect(find.byKey(feedbackRemoveImageKey(1)), findsOneWidget);
    expect(find.byKey(kFeedbackAddImageKey), findsOneWidget);
  });

  testWidgets('submit uploads the picked images, then posts with their paths',
      (WidgetTester tester) async {
    final _FakeUploader uploader = _FakeUploader();
    wire(picker: _FakePicker(bytes: sampleBytes), uploader: uploader);
    when(() => repo.submit(
          message: any(named: 'message'),
          category: any(named: 'category'),
          screen: any(named: 'screen'),
          attachmentPaths: any(named: 'attachmentPaths'),
        )).thenAnswer((_) async {});

    final GoRouter router = await pump(tester);
    await tester.enterText(find.byType(TextField), 'kuch dikkat');
    await tester.pump();
    await addOneImage(tester);
    await addOneImage(tester);

    await tester.tap(find.text('Bhejein'));
    await tester.pumpAndSettle();

    // Both images uploaded BEFORE the post…
    expect(uploader.uploaded.length, 2);
    // …and the successful paths reached repo.submit in order.
    final List<dynamic> captured = verify(() => repo.submit(
          message: captureAny(named: 'message'),
          category: any(named: 'category'),
          screen: any(named: 'screen'),
          attachmentPaths: captureAny(named: 'attachmentPaths'),
        )).captured;
    expect(captured[0], 'kuch dikkat');
    expect(captured[1], <String>[
      'feedback-attachments/w1/img-0.jpg',
      'feedback-attachments/w1/img-1.jpg',
    ]);
    // Success: popped home with the thank-you.
    expect(router.routerDelegate.currentConfiguration.uri.toString(), '/home');
    expect(find.textContaining('Shukriya'), findsOneWidget);
  });

  testWidgets(
      'every image upload fails → the TEXT still sends + an honest photo notice',
      (WidgetTester tester) async {
    final _FakeUploader uploader = _FakeUploader(fail: true);
    wire(picker: _FakePicker(bytes: sampleBytes), uploader: uploader);
    when(() => repo.submit(
          message: any(named: 'message'),
          category: any(named: 'category'),
          screen: any(named: 'screen'),
          attachmentPaths: any(named: 'attachmentPaths'),
        )).thenAnswer((_) async {});

    final GoRouter router = await pump(tester);
    await tester.enterText(find.byType(TextField), 'kuch dikkat');
    await tester.pump();
    await addOneImage(tester);

    await tester.tap(find.text('Bhejein'));
    await tester.pumpAndSettle();

    // The uploader WAS tried…
    expect(uploader.uploaded.length, 1);
    // …but with nothing uploaded, the post carries NO attachment_paths (the
    // no-image call shape) — the text is never blocked by a dropped photo.
    verify(() => repo.submit(
          message: 'kuch dikkat',
          category: null,
          screen: null,
        )).called(1);
    // And the worker is told, honestly, that the photo did not attach.
    expect(find.textContaining('Photo attach nahi ho payi'), findsOneWidget);
    expect(router.routerDelegate.currentConfiguration.uri.toString(), '/home');
  });

  testWidgets('a cancelled pick attaches nothing', (WidgetTester tester) async {
    wire(picker: _FakePicker(bytes: null)); // picker returns null = cancelled
    await pump(tester);
    await addOneImage(tester);
    expect(find.byKey(kFeedbackImageStripKey), findsNothing);
    expect(find.byKey(kFeedbackAddImageKey), findsOneWidget);
  });
}
