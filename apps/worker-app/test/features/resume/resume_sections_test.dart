import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/widgets/kit/kit_info_chip.dart';
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
      'Availability, Terms & Salary',
    ]) {
      expect(find.text(title), findsOneWidget, reason: 'missing section: $title');
    }
    // Nothing spilled into the generic bucket.
    expect(find.text('More'), findsNothing);
  });

  testWidgets('Work History shows each job as a VALUE-only line (no label prefix)',
      (WidgetTester tester) async {
    await pumpSections(tester, full);

    // Each job is a block: the role as its title, the rest under it — every
    // character of the line kept (OWNER ASK 2026-10-21).
    expect(find.text('CNC Operator'), findsWidgets);
    expect(find.text('ABC Ltd — 3 years'), findsOneWidget);
    expect(find.text('Helper'), findsOneWidget);
    expect(find.text('XYZ Works — 2 years'), findsOneWidget);
    // …with no redundant "Work history:" prefix on the rows.
    expect(find.textContaining('Work history:', findRichText: true), findsNothing);
  });

  testWidgets('Availability, Terms & Salary render their values', (
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

    // The friendly label shows (caption over its value)…
    expect(find.text('EDUCATION LEVEL'), findsOneWidget);
    expect(find.text('10th se kam'), findsOneWidget);
    // …and the raw DB token is nowhere on the screen.
    expect(find.textContaining('below_10', findRichText: true), findsNothing);
  });

  testWidgets(
      'night-shift readiness renders as a Yes/No fact under Availability, '
      'Terms & Salary (OWNER ASK 2026-10-21 — a work term, not a place)',
      (WidgetTester tester) async {
    await pumpWithNightShift(tester, true);
    expect(find.text('Availability, Terms & Salary'), findsOneWidget);
    expect(find.text('NIGHT SHIFT KE LIYE TAIYAAR'), findsOneWidget);
    expect(find.text('Yes'), findsOneWidget);
    // The caption sits inside the Availability card, below its header.
    expect(
      tester.getTopLeft(find.text('NIGHT SHIFT KE LIYE TAIYAAR')).dy,
      greaterThan(
        tester.getTopLeft(find.text('Availability, Terms & Salary')).dy,
      ),
    );

    await pumpWithNightShift(tester, false);
    expect(find.text('No'), findsOneWidget);
  });

  // OWNER ASK (2026-10-21, issue screenshot) — the plumber résumé that read as
  // two paragraphs.
  const String plumber = """WORKER PROFILE (DRAFT)

Role: Plumber
Skills: Pipe fitting, Maintenance, Installation, PVC pipe work, Copper pipe work, Fittings installation, Soldering, Welding, Leak detection, Pressure gauge operation, Acoustic device operation, Dye tracer operation
Work history: Plumber — 10 saal — Performed pipe fitting, maintenance, and installation work using PVC and copper pipes; conducted leak detection using acoustic devices, dye tracers, and pressure gauges; performed soldering and welding.
Availability: Available immediately""";

  testWidgets(
      'OWNER ASK 2026-10-21: Skills are a chip grid — one chip per skill, '
      'every skill kept', (WidgetTester tester) async {
    await pumpSections(tester, plumber);
    expect(find.text('SKILLS'), findsOneWidget);
    expect(find.byType(KitInfoChip), findsNWidgets(12));
    for (final String skill in <String>[
      'Pipe fitting',
      'Dye tracer operation',
      'Pressure gauge operation',
    ]) {
      expect(find.widgetWithText(KitInfoChip, skill), findsOneWidget);
    }
    // No run-on "Skills: a, b, c" paragraph any more.
    expect(find.textContaining('Skills:', findRichText: true), findsNothing);
  });

  testWidgets(
      'OWNER ASK 2026-10-21: a job is a block — role title, duration pill, '
      'work done as body text', (WidgetTester tester) async {
    await pumpSections(tester, plumber);
    expect(find.text('10 saal'), findsOneWidget);
    expect(
      find.textContaining('Performed pipe fitting, maintenance'),
      findsOneWidget,
    );
    // The duration sits beside the role, above the work text.
    final double role = tester.getTopLeft(find.text('Plumber').last).dy;
    final double work = tester
        .getTopLeft(find.textContaining('Performed pipe fitting'))
        .dy;
    expect(work, greaterThan(role));
  });

  test('splitResumeList keeps a bracketed item whole and loses nothing', () {
    expect(
      splitResumeList('Welding (MIG, TIG), Grinding, Fitting'),
      <String>['Welding (MIG, TIG)', 'Grinding', 'Fitting'],
    );
    expect(splitResumeList('Turning'), <String>['Turning']);
    expect(splitResumeList(''), isEmpty);
  });

  testWidgets(
      'Preferred locations stay ONE value (a place can carry a comma, '
      '"Gurugram, Haryana")', (WidgetTester tester) async {
    await pumpSections(tester, full);
    expect(find.text('Jaipur, Pune'), findsOneWidget);
  });
}
