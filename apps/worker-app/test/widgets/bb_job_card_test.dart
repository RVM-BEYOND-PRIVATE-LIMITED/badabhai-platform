import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/theme/app_spacing.dart';
import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/core/widgets/bb_job_card.dart';
import 'package:badabhai_worker_app/core/widgets/bb_tag.dart';

Widget _host(Widget child) => MaterialApp(
      theme: AppTheme.light(),
      home: Scaffold(body: Center(child: child)),
    );

void main() {
  group('BbJobCard', () {
    const BbJobCardData data = BbJobCardData(
      title: 'CNC Operator',
      company: 'Sharma Works',
      payBand: '22-28k',
      place: 'Pimpri',
      shift: 'Day',
      tags: <String>['Fanuc'],
      spotsLeft: 4,
    );

    testWidgets('renders title, the company·location line and the salary',
        (tester) async {
      await tester.pumpWidget(_host(const BbJobCard(data: data)));

      expect(find.text('CNC Operator'), findsOneWidget);
      // Company and location now share ONE line (kit "company · location").
      expect(find.textContaining('Sharma Works'), findsOneWidget);
      expect(find.textContaining('Pimpri'), findsOneWidget);
      // Salary renders the bare pay string alongside a muted "/mah".
      expect(find.text('22-28k'), findsOneWidget);
      expect(find.text(' /mah'), findsOneWidget);
    });

    testWidgets('a featured card earns the HOT tag; a plain one does not',
        (tester) async {
      await tester.pumpWidget(_host(const BbJobCard(data: data)));
      expect(find.byType(BbHotTag), findsNothing);

      await tester.pumpWidget(_host(const BbJobCard(
        data: BbJobCardData(
          title: 'VMC Operator',
          place: 'Chakan',
          hot: true,
        ),
      )));
      expect(find.byType(BbHotTag), findsOneWidget);
      expect(find.text('HOT'), findsOneWidget);
    });

    testWidgets('fires onApply when the APPLY action is tapped', (tester) async {
      int applied = 0;
      await tester.pumpWidget(_host(BbJobCard(
        data: const BbJobCardData(
          title: 'VMC Operator',
          place: 'Chakan',
          payBand: '18-22k',
        ),
        onApply: () => applied++,
      )));

      await tester.tap(find.byKey(const Key('jobCardApplyButton')));
      expect(applied, 1);
    });

    testWidgets('shows metaRight when there is no apply action',
        (tester) async {
      await tester.pumpWidget(_host(const BbJobCard(
        data: BbJobCardData(
          title: 'CNC Setter',
          place: 'Bhosari',
          metaRight: 'General shift',
        ),
      )));

      expect(find.text('General shift'), findsOneWidget);
      expect(find.byKey(const Key('jobCardApplyButton')), findsNothing);
    });

    // `verified` now defaults to FALSE: the seal must be an explicit opt-in for
    // a REAL employer. It previously defaulted to true, so the card stamped a
    // green "verified" seal next to an employer name invented from
    // `jobId.hashCode`.
    testWidgets('shows the verified seal only when verified is explicitly true',
        (tester) async {
      await tester.pumpWidget(_host(const BbJobCard(data: data)));
      expect(find.byIcon(Icons.verified), findsNothing);

      await tester.pumpWidget(_host(const BbJobCard(
        data: BbJobCardData(
          title: 'CNC Operator',
          company: 'Sharma Works',
          verified: true,
          place: 'Pimpri',
        ),
      )));
      expect(find.byIcon(Icons.verified), findsOneWidget);
    });

    // The real feed carries no employer/pay/shift/tags — the card must simply
    // omit them rather than render an invented value.
    testWidgets('omits employer, pay, shift and tags when the feed has none',
        (tester) async {
      await tester.pumpWidget(_host(const BbJobCard(
        data: BbJobCardData(title: 'CNC Operator', place: 'Pimpri, Pune'),
      )));

      expect(find.text('CNC Operator'), findsOneWidget);
      expect(find.text('Pimpri, Pune'), findsOneWidget);
      expect(find.byIcon(Icons.currency_rupee), findsNothing);
      expect(find.byIcon(Icons.schedule), findsNothing);
      expect(find.byIcon(Icons.verified), findsNothing);
      expect(find.textContaining('spots'), findsNothing);
    });

    testWidgets('fires onTitleTap when the title is tapped', (tester) async {
      int taps = 0;
      await tester.pumpWidget(_host(
        BbJobCard(data: data, onTitleTap: () => taps++),
      ));

      await tester.tap(find.text('CNC Operator'));
      expect(taps, 1);
    });

    // #362 — in the deck this title is the ONLY route to the job detail (the pan
    // recognizer claims the rest of the card). It was a bare GestureDetector
    // around a ~26px text line, under the design system's 48px worker
    // touch-target floor, so a gloved tap landing just below the glyphs fell
    // through to the drag and merely wiggled the card.
    testWidgets('the title button meets the 48px worker touch-target floor',
        (tester) async {
      await tester.pumpWidget(_host(
        BbJobCard(data: data, onTitleTap: () {}),
      ));

      final Size size =
          tester.getSize(find.byKey(const Key('jobCardTitleButton')));
      expect(size.height, greaterThanOrEqualTo(AppSpacing.tap));
    });

    // #362 — a ripple needs a Material ANCESTOR to splash on; BbFestiveCard is a
    // plain DecoratedBox with an opaque fill, so the card carries its own
    // transparent Material or the ink paints underneath and is never seen.
    testWidgets('the title is an InkWell with a Material to ripple on',
        (tester) async {
      await tester.pumpWidget(_host(
        BbJobCard(data: data, onTitleTap: () {}),
      ));

      final Finder inkWell = find.byKey(const Key('jobCardTitleButton'));
      expect(inkWell, findsOneWidget);
      expect(tester.widget(inkWell), isA<InkWell>());
      expect(
        find.ancestor(of: inkWell, matching: find.byType(Material)),
        findsWidgets,
      );
      // A visible "this opens something" cue for a low-literacy worker.
      expect(find.byIcon(Icons.chevron_right), findsOneWidget);
    });

    // #362 — TalkBack heard the title as plain text: no button role, no hint
    // that it activates anything. It must now be ONE focusable button node
    // carrying both the job title and the Hinglish hint.
    testWidgets('the title exposes a button role and a spoken label',
        (tester) async {
      final SemanticsHandle handle = tester.ensureSemantics();
      await tester.pumpWidget(_host(
        BbJobCard(data: data, onTitleTap: () {}),
      ));

      final SemanticsNode node =
          tester.getSemantics(find.byKey(const Key('jobCardTitleButton')));
      expect(node.label, contains(kJobCardTitleSemanticLabel));
      expect(node.label, contains('CNC Operator'));
      expect(node.getSemanticsData().flagsCollection.isButton, isTrue);
      expect(node.getSemanticsData().hasAction(SemanticsAction.tap), isTrue);
      handle.dispose();
    });

    // A static card (no callback) must stay inert — no button role, no chevron
    // promising a route that isn't wired.
    testWidgets('a card without onTitleTap renders a plain, inert title',
        (tester) async {
      final SemanticsHandle handle = tester.ensureSemantics();
      await tester.pumpWidget(_host(const BbJobCard(data: data)));

      expect(find.byKey(const Key('jobCardTitleButton')), findsNothing);
      expect(find.byIcon(Icons.chevron_right), findsNothing);
      expect(find.bySemanticsLabel(kJobCardTitleSemanticLabel), findsNothing);
      handle.dispose();
    });

    testWidgets('omits the quota line when spotsLeft is null', (tester) async {
      await tester.pumpWidget(_host(const BbJobCard(
        data: BbJobCardData(
          title: 'Welder',
          company: 'Patel Fab',
          payBand: '18-24k',
          place: 'Bhosari',
          shift: 'Night',
        ),
      )));

      expect(find.textContaining('spots'), findsNothing);
    });
  });

  // ── The deck layout ───────────────────────────────────────────────────────
  // The swipe card renders the SAME data as the list row, arranged for a card
  // that owns a screen. These pin the difference in both directions so the two
  // layouts cannot silently converge again.
  group('BbJobCard — deck layout', () {
    const BbJobCardData data = BbJobCardData(
      title: 'CNC Operator',
      payBand: '22-28k',
      place: 'Pimpri, Pune',
      shift: 'Day shift',
      matchNote: 'Aapke lathe ke kaam se milta-julta hai.',
    );

    Widget deckHost(BbJobCardData d, {Size size = const Size(400, 640)}) =>
        MaterialApp(
          theme: AppTheme.light(),
          home: Scaffold(
            body: Center(
              child: SizedBox(
                width: size.width,
                height: size.height,
                child: BbJobCard(data: d, layout: BbJobCardLayout.deck),
              ),
            ),
          ),
        );

    testWidgets('surfaces the shift the list row drops', (tester) async {
      await tester.pumpWidget(deckHost(data));

      expect(find.text('CNC Operator'), findsOneWidget);
      expect(find.text('22-28k'), findsOneWidget);
      // The list row keeps `shift` on the model and never renders it; the deck
      // card has the room, so it shows it.
      expect(find.text('Day shift'), findsOneWidget);
    });

    // The CARD carries no Skip/Apply affordance of its own: the deck's two big
    // buttons below it (`swipeSkipButton` / `swipeApplyButton`, owned by
    // `JobDeck`) are the only ones, and a second pair printed on the card read
    // as controls that could not be pressed. Owner call — kept as a guard so
    // they cannot drift back onto the card.
    testWidgets('carries no Skip/Apply labels of its own', (tester) async {
      await tester.pumpWidget(deckHost(data));

      expect(find.text('Skip'), findsNothing);
      expect(find.text('Apply'), findsNothing);
    });

    testWidgets('the title stays a real 48px button with its spoken label',
        (tester) async {
      final SemanticsHandle handle = tester.ensureSemantics();
      bool tapped = false;
      await tester.pumpWidget(MaterialApp(
        theme: AppTheme.light(),
        home: Scaffold(
          body: SizedBox(
            height: 640,
            child: BbJobCard(
              data: data,
              layout: BbJobCardLayout.deck,
              onTitleTap: () => tapped = true,
            ),
          ),
        ),
      ));

      // MergeSemantics folds the title text INTO this node, so the label is
      // "<title>\n<action label>" — matched by containment, exactly as the
      // list-layout test above does.
      final SemanticsNode node =
          tester.getSemantics(find.byKey(const Key('jobCardTitleButton')));
      expect(node.label, contains(kJobCardTitleSemanticLabel));
      expect(node.label, contains('CNC Operator'));
      expect(node.getSemanticsData().flagsCollection.isButton, isTrue);
      expect(
        tester.getSize(find.byKey(const Key('jobCardTitleButton'))).height,
        greaterThanOrEqualTo(AppSpacing.tap),
      );
      await tester.tap(find.byKey(const Key('jobCardTitleButton')));
      expect(tapped, isTrue);
      handle.dispose();
    });

    // The deck card FILLS its box, so a cramped phone is exactly where a
    // too-tall layout would overflow. The spacer is Flexible for this reason.
    testWidgets('does not overflow on a short, narrow handset', (tester) async {
      await tester.pumpWidget(deckHost(
        const BbJobCardData(
          title: 'CNC Turner / Setter for a precision components shop',
          payBand: '22-28k',
          place: 'Pimpri-Chinchwad, Pune',
          shift: 'Rotational shift',
          matchNote: 'Aapke lathe ke kaam se milta-julta hai.',
        ),
        size: const Size(320, 380),
      ));

      expect(tester.takeException(), isNull);
    });

    testWidgets('renders nothing it was not given (no pay, no shift, no note)',
        (tester) async {
      await tester.pumpWidget(deckHost(
        const BbJobCardData(title: 'Welder', place: 'Pune'),
      ));

      expect(find.text('Welder'), findsOneWidget);
      expect(find.textContaining('/mah'), findsNothing);
      expect(tester.takeException(), isNull);
    });
  });
}
