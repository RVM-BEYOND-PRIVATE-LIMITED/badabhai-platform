import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/features/resume/presentation/widgets/resume_sections.dart';

/// The section renderer must own EVERY label `build_resume` can emit, so nothing
/// falls into the generic "More" bucket — including the ones added when the
/// deterministic template started riding the real LLM path (#909): Work history
/// (repeatable), Availability, and Expected salary.
void main() {
  // The full shape apps/ai-service/app/extraction.py `build_resume` emits.
  const String full = '''WORKER PROFILE (DRAFT)

Role: CNC Operator
Trade: CNC Machining
Experience: 5 years
Machines: VMC, HMC
Skills: Milling, Turning
Work history: CNC Operator — ABC Ltd — 3 years
Work history: Helper — XYZ Works — 2 years
Education level: ITI
Field of study: Mechanical
Certifications: NCVT
Current location: Kota
Preferred locations: Jaipur, Pune
Availability: Available immediately
Expected salary: 20000 per month''';

  Future<void> pumpSections(WidgetTester tester, String text) async {
    final ParsedResume parsed = parseResumeText(text);
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: SingleChildScrollView(child: ResumeSectionsView(parsed: parsed)),
      ),
    ));
  }

  testWidgets('every template field lands in a named section — never in "More"',
      (WidgetTester tester) async {
    await pumpSections(tester, full);

    // All six sections present, including the newly-owned ones.
    for (final String title in <String>[
      'General Info',
      'Technical Skills',
      'Work History',
      'Education & Certifications',
      'Location',
      'Availability & Salary',
    ]) {
      expect(find.text(title), findsOneWidget, reason: 'missing section: $title');
    }
    // Nothing spilled into the generic bucket.
    expect(find.text('More'), findsNothing);
  });

  testWidgets('Work History shows each job as a VALUE-only line (no label prefix)',
      (WidgetTester tester) async {
    await pumpSections(tester, full);

    // Both jobs render as plain values under the section title…
    expect(find.text('CNC Operator — ABC Ltd — 3 years'), findsOneWidget);
    expect(find.text('Helper — XYZ Works — 2 years'), findsOneWidget);
    // …with no redundant "Work history:" prefix on the rows.
    expect(find.textContaining('Work history:', findRichText: true), findsNothing);
  });

  testWidgets('Availability & Salary render their values', (
    WidgetTester tester,
  ) async {
    await pumpSections(tester, full);

    expect(find.textContaining('Available immediately', findRichText: true),
        findsWidgets);
    expect(find.textContaining('20000 per month', findRichText: true),
        findsWidgets);
  });

  // Night-shift readiness is a worker PREF carried outside the resume text; it is
  // injected as a Yes/No row under Location and MUST always render on the tab.
  Future<void> pumpWithNightShift(WidgetTester tester, bool ready) async {
    final ParsedResume parsed = parseResumeText(full, nightShiftReady: ready);
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: SingleChildScrollView(child: ResumeSectionsView(parsed: parsed)),
      ),
    ));
  }

  testWidgets(
      'education level is humanized — a raw `below_10` token never reaches the '
      'screen', (WidgetTester tester) async {
    // The deterministic template carries the raw scalar the extractor emits.
    const String withToken = '''WORKER PROFILE (DRAFT)

Role: CNC Operator
Education level: below_10
Current location: Faridabad''';

    await pumpSections(tester, withToken);

    // The friendly label shows…
    expect(
      find.textContaining('Education level: 10th se kam', findRichText: true),
      findsOneWidget,
    );
    // …and the raw DB token is nowhere on the screen.
    expect(find.textContaining('below_10', findRichText: true), findsNothing);
  });

  testWidgets('night-shift readiness renders as a Yes/No row under Location',
      (WidgetTester tester) async {
    await pumpWithNightShift(tester, true);
    expect(find.text('Location'), findsOneWidget);
    expect(find.textContaining('Night shift ke liye taiyaar', findRichText: true),
        findsOneWidget);
    expect(find.textContaining('Night shift ke liye taiyaar: Yes',
            findRichText: true),
        findsOneWidget);

    await pumpWithNightShift(tester, false);
    expect(find.textContaining('Night shift ke liye taiyaar: No',
            findRichText: true),
        findsOneWidget);
  });
}
