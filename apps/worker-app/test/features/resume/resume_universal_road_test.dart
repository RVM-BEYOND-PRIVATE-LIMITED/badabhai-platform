import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart';

import 'resume_tab_harness.dart';

/// #1580 — a fallback-pack (`qp_universal`, role-less, chat-road) worker gets
/// a COMPLETE résumé preview: the chat-road type, only the sections their
/// facts fill, no invented trade names, and no dead ends.
///
/// Nothing here invents server behavior: the chat road always renders the
/// flat legacy body under its own heading (never the trade sheet's zoned
/// cards), and empty legacy sections are skipped by construction.
void main() {
  final ResumeTabHarness harness = ResumeTabHarness();

  tearDown(ResumeTabHarness.reset);

  Future<void> pumpTab(WidgetTester tester) async {
    tester.view.physicalSize = const Size(900, 1900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(harness.app());
    await tester.pump();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
  }

  /// A role-less chat-road worker with two sparse facts and nothing else.
  Future<void> wireUniversal(WidgetTester tester) async {
    await harness.wire(
      document: const GenericResumeDocument(
        header: ResumeDocumentHeaderDto(name: 'Suresh Yadav'),
        source: 'chat',
      ),
      resumeText: 'Current location: Faridabad\nAvailability: Immediately\n',
      renderStatus: 'rendered',
      profileConfirmed: true,
      name: 'Suresh Yadav',
    );
    await pumpTab(tester);
  }

  group('universal fallback-pack résumé', () {
    testWidgets('renders the chat-road type with only the filled sections',
        (WidgetTester tester) async {
      await wireUniversal(tester);

      // The chat-road type, not a trade sheet wearing chat data.
      expect(find.text('Chat se bana resume'), findsOneWidget);
      // Owned sections render…
      expect(find.text('Location'), findsOneWidget);
      expect(find.text('Availability & Salary'), findsOneWidget);
      // Entry rows are RichText (`Label: value`), not plain Text.
      expect(
        find.textContaining('Faridabad', findRichText: true),
        findsWidgets,
      );
      // …empty ones do not — no heading-only stubs.
      expect(find.text('General Info'), findsNothing);
      expect(find.text('Technical Skills'), findsNothing);
      expect(find.text('Work History'), findsNothing);
      expect(find.text('Education & Certifications'), findsNothing);
    });

    testWidgets('names no trade the worker does not have',
        (WidgetTester tester) async {
      await wireUniversal(tester);

      expect(find.textContaining('CNC'), findsNothing);
      expect(find.textContaining('Welder'), findsNothing);
      expect(find.textContaining('Turner'), findsNothing);
      expect(find.textContaining('role_'), findsNothing);
      expect(find.textContaining('qp_'), findsNothing);
    });

    testWidgets('no dead ends: share, download and correction stay reachable',
        (WidgetTester tester) async {
      await wireUniversal(tester);

      expect(find.text('WhatsApp pe bhejein'), findsOneWidget);
      expect(find.text('PDF download karein'), findsOneWidget);
      expect(find.text('Report correction'), findsOneWidget);
    });
  });
}
