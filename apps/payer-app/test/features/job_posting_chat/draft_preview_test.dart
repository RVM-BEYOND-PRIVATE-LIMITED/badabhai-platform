import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:payer_app/core/data/job_posting_chat_models.dart';
import 'package:payer_app/core/widgets/bb_button.dart';
import 'package:payer_app/core/widgets/bb_field.dart';
import 'package:payer_app/features/job_posting_chat/presentation/widgets/draft_preview.dart';

/// #2490/#2493 — the AI chat publishes the worker card's `role_kind` and `area`
/// from the publish step. These pin the controls and their wiring, because the
/// interview does not always collect them.
void main() {
  const JobPostingDraft draft = JobPostingDraft(
    roleTitle: 'CNC Setter',
    vacancyBand: '2-5',
  );

  Future<void> pump(
    WidgetTester tester, {
    bool ready = true,
    String? roleKind,
    String area = '',
    required ValueChanged<String?> onRoleKindChanged,
    required ValueChanged<String> onAreaChanged,
    required VoidCallback onPublish,
  }) {
    return tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SingleChildScrollView(
            child: DraftPreview(
              draft: draft,
              ready: ready,
              publishing: false,
              roleKind: roleKind,
              onRoleKindChanged: onRoleKindChanged,
              area: area,
              onAreaChanged: onAreaChanged,
              onPublish: onPublish,
            ),
          ),
        ),
      ),
    );
  }

  testWidgets('offers the optional role pick and publishes the draft',
      (WidgetTester tester) async {
    String? picked;
    bool published = false;
    await pump(
      tester,
      onRoleKindChanged: (String? v) => picked = v,
      onAreaChanged: (_) {},
      onPublish: () => published = true,
    );

    // The role control is on the publish step, defaulting to "Not specified".
    expect(find.byType(BbSelect<String?>), findsOneWidget);
    expect(find.text('Role (card illustration)'), findsOneWidget);
    expect(find.text('Not specified'), findsOneWidget);

    // Selecting a role bubbles the closed-set value to the caller.
    tester.widget<BbSelect<String?>>(find.byType(BbSelect<String?>))
        .onChanged('cnc_turner');
    expect(picked, 'cnc_turner');

    await tester.tap(find.widgetWithText(BbButton, kDraftPublishLabel));
    expect(published, isTrue);
  });

  testWidgets('prefills the area from the draft and reports edits (#2493)',
      (WidgetTester tester) async {
    final List<String> edits = <String>[];
    await pump(
      tester,
      area: 'Chakan',
      onRoleKindChanged: (_) {},
      onAreaChanged: edits.add,
      onPublish: () {},
    );

    // The input is prefilled from the interview draft.
    expect(find.text('Area / locality'), findsOneWidget);
    final BbField field = tester.widget<BbField>(find.byType(BbField));
    expect(field.controller?.text, 'Chakan');

    // An edit bubbles up as the publish-step value.
    await tester.enterText(find.byType(BbField), 'Bhosari');
    expect(edits.last, 'Bhosari');
  });

  testWidgets('an unready draft keeps Publish disarmed', (WidgetTester tester) async {
    bool published = false;
    await pump(
      tester,
      ready: false,
      onRoleKindChanged: (_) {},
      onAreaChanged: (_) {},
      onPublish: () => published = true,
    );

    final BbButton button = tester.widget<BbButton>(find.byType(BbButton));
    expect(button.onPressed, isNull);
    expect(published, isFalse);
  });
}
