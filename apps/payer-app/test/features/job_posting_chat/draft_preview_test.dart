import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:payer_app/core/data/job_posting_chat_models.dart';
import 'package:payer_app/core/data/models.dart';
import 'package:payer_app/core/error/payer_failure.dart';
import 'package:payer_app/core/widgets/bb_button.dart';
import 'package:payer_app/core/widgets/bb_field.dart';
import 'package:payer_app/core/widgets/bb_shake.dart';
import 'package:payer_app/features/job_posting_chat/presentation/widgets/draft_preview.dart';

/// #2490/#2493 — the AI chat publishes the job's `role_kind` and `area` from
/// the publish step, because the interview does not always collect them.
///
/// #2635 — a company job matches only within the 16 postable trades, and the
/// posting the chat creates can never go live without one. So the role IS the
/// trade: picked from the 16 the catalogue lists, and REQUIRED — a Publish tap
/// without it is refused at the picker and nothing is sent.
void main() {
  const JobPostingDraft draft = JobPostingDraft(
    roleTitle: 'CNC Setter',
    vacancyBand: '2-5',
  );

  const List<PostingTradeForm> trades = <PostingTradeForm>[
    PostingTradeForm(
      roleKind: 'cnc_turner',
      roleLabel: 'CNC Turner',
      packId: 'qp_cnc_turning',
      matchSkillId: 'mskill_cnc_turner',
    ),
    PostingTradeForm(
      roleKind: 'welder',
      roleLabel: 'Welder',
      packId: 'qp_welding_trade',
      matchSkillId: 'mskill_welder',
    ),
  ];

  /// The publish step, its trade pick held by a parent the way the chat
  /// screen holds it.
  Future<void> pump(
    WidgetTester tester, {
    bool ready = true,
    String area = '',
    List<PostingTradeForm> trades = trades,
    bool tradesLoading = false,
    PayerFailure? tradesFailure,
    VoidCallback? onRetryTrades,
    ValueChanged<String?>? onRoleKindChanged,
    ValueChanged<String>? onAreaChanged,
    VoidCallback? onPublish,
  }) {
    String? picked;
    return tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SingleChildScrollView(
            child: StatefulBuilder(
              builder: (BuildContext context, StateSetter setState) =>
                  DraftPreview(
                draft: draft,
                ready: ready,
                publishing: false,
                roleKind: picked,
                onRoleKindChanged: (String? kind) {
                  setState(() => picked = kind);
                  onRoleKindChanged?.call(kind);
                },
                trades: trades,
                tradesLoading: tradesLoading,
                tradesFailure: tradesFailure,
                onRetryTrades: onRetryTrades ?? () {},
                area: area,
                onAreaChanged: onAreaChanged ?? (_) {},
                onPublish: onPublish ?? () {},
              ),
            ),
          ),
        ),
      ),
    );
  }

  Future<void> pickTrade(WidgetTester tester, String label) async {
    await tester.tap(find.text('— pick the role —'));
    await tester.pumpAndSettle();
    await tester.tap(find.text(label).last);
    await tester.pumpAndSettle();
  }

  Future<void> tapPublish(WidgetTester tester) async {
    await tester.tap(find.widgetWithText(BbButton, kDraftPublishLabel));
    await tester.pumpAndSettle();
  }

  /// [text] AT the trade picker (inside its shake anchor).
  Finder atPicker(String text) => find.descendant(
        of: find.ancestor(of: find.text('Role'), matching: find.byType(BbShake)),
        matching: find.text(text),
      );

  testWidgets('offers the 16 trades — no free role list — and publishes one',
      (WidgetTester tester) async {
    final List<String?> picks = <String?>[];
    int published = 0;
    await pump(
      tester,
      onRoleKindChanged: picks.add,
      onPublish: () => published++,
    );

    expect(find.byType(BbSelect<String?>), findsOneWidget);
    expect(find.text('Role'), findsOneWidget);
    expect(find.text('— pick the role —'), findsOneWidget);
    // The interview's title reads as the forms call it, never as a second
    // "Role" beside the trade picker.
    expect(find.text('Job title'), findsOneWidget);
    expect(find.text('CNC Setter'), findsOneWidget);
    // The old optional pick: every declared role, plus "no role".
    expect(find.text('Role (card illustration)'), findsNothing);
    expect(find.text('Not specified'), findsNothing);

    await pickTrade(tester, 'Welder');
    expect(picks, <String?>['welder']);

    await tapPublish(tester);
    expect(published, 1);
  });

  testWidgets(
      'a Publish with no trade is refused AT the picker — nothing is sent',
      (WidgetTester tester) async {
    int published = 0;
    await pump(tester, onPublish: () => published++);

    await tapPublish(tester);

    expect(published, 0);
    expect(atPicker('Pick one of the 16 trades'), findsOneWidget);

    // Picking a trade clears it, and the next tap publishes.
    await pickTrade(tester, 'CNC Turner');
    expect(find.text('Pick one of the 16 trades'), findsNothing);
    await tapPublish(tester);
    expect(published, 1);
  });

  testWidgets('trades that fail to load say why and offer a retry', (
    WidgetTester tester,
  ) async {
    int retries = 0;
    int published = 0;
    await pump(
      tester,
      trades: const <PostingTradeForm>[],
      tradesFailure: const PayerFailure(PayerFailureKind.network),
      onRetryTrades: () => retries++,
      onPublish: () => published++,
    );

    expect(
      atPicker(
        'The 16 trades did not load. Check your internet connection and try '
        'again.',
      ),
      findsOneWidget,
    );
    expect(find.byType(BbSelect<String?>), findsNothing);

    await tester.tap(find.widgetWithText(BbButton, 'Retry'));
    expect(retries, 1);

    // Still never published without a trade.
    await tapPublish(tester);
    expect(published, 0);
    expect(atPicker('Pick one of the 16 trades'), findsOneWidget);
  });

  testWidgets('while the trades load, the picker says so', (
    WidgetTester tester,
  ) async {
    await pump(
      tester,
      trades: const <PostingTradeForm>[],
      tradesLoading: true,
    );

    expect(atPicker('Loading roles…'), findsOneWidget);
    expect(find.byType(BbSelect<String?>), findsNothing);
  });

  testWidgets('prefills the area from the draft and reports edits (#2493)',
      (WidgetTester tester) async {
    final List<String> edits = <String>[];
    await pump(tester, area: 'Chakan', onAreaChanged: edits.add);

    // The input is prefilled from the interview draft.
    expect(find.text('Area / locality'), findsOneWidget);
    final BbField field = tester.widget<BbField>(find.byType(BbField));
    expect(field.controller?.text, 'Chakan');

    // An edit bubbles up as the publish-step value.
    await tester.enterText(find.byType(BbField), 'Bhosari');
    expect(edits.last, 'Bhosari');
  });

  testWidgets('an unready draft keeps Publish disarmed', (
    WidgetTester tester,
  ) async {
    int published = 0;
    await pump(tester, ready: false, onPublish: () => published++);

    final BbButton button = tester
        .widget<BbButton>(find.widgetWithText(BbButton, kDraftPublishLabel));
    expect(button.onPressed, isNull);
    expect(published, 0);
  });
}
