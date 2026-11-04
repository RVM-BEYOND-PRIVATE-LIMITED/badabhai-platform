import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:payer_app/core/error/payer_failure.dart';
import 'package:payer_app/core/theme/app_colors.dart';
import 'package:payer_app/core/theme/app_motion.dart';
import 'package:payer_app/core/widgets/bb_refresh.dart';
import 'package:payer_app/core/widgets/bb_skeleton.dart';
import 'package:payer_app/core/widgets/bb_tab_scope.dart';

/// #2592 (M4) — the loading & refresh primitives: skeletons shaped like their
/// content (shimmering once every 1.2s, static under reduced motion), the
/// 200ms skeleton → content cross-fade, dimmed stale rows under a thin bar,
/// the brand pull-to-refresh, the honest refresh toast, and the automatic
/// load-more trigger with its 160ms row.
void main() {
  /// [child] in an app with animations DISABLED unless [motion] is true.
  Widget app(Widget child, {bool motion = false}) => MaterialApp(
        builder: (BuildContext context, Widget? home) => MediaQuery(
          data: MediaQuery.of(context).copyWith(disableAnimations: !motion),
          child: home!,
        ),
        home: Scaffold(body: child),
      );

  /// A 360×640 phone.
  void phone(WidgetTester tester) {
    tester.view.physicalSize = const Size(360, 640);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
  }

  test('motion tokens: shimmer 1.2s · content 200ms · load-more 160ms · 60%',
      () {
    expect(AppMotion.shimmer, const Duration(milliseconds: 1200));
    expect(AppMotion.contentFade, const Duration(milliseconds: 200));
    expect(AppMotion.loadMoreFade, const Duration(milliseconds: 160));
    expect(AppMotion.staleOpacity, 0.6);
  });

  group('skeletons', () {
    testWidgets('candidate, job and ledger skeletons fit a 360×640 phone',
        (WidgetTester tester) async {
      phone(tester);
      await tester.pumpWidget(app(const Column(
        children: <Widget>[
          Expanded(
            child: BbSkeletonList(
              header: BbSkeletonHeader(),
              row: BbSkeletonCandidateRow(),
              count: 2,
            ),
          ),
          Expanded(
            child: BbSkeletonList(
              items: <Widget>[BbSkeletonJobRow(), BbSkeletonLedgerCard()],
            ),
          ),
        ],
      )));
      await tester.pumpAndSettle();

      expect(tester.takeException(), isNull, reason: 'no overflow at 360dp');
      expect(find.byType(BbSkeletonCandidateRow), findsNWidgets(2));
      expect(find.byType(BbSkeletonJobRow), findsOneWidget);
      expect(find.byType(BbSkeletonLedgerRow), findsNWidgets(4));
      expect(find.byType(CircularProgressIndicator), findsNothing);
    });

    testWidgets('blocks are existing tokens; one announcement, not the blocks',
        (WidgetTester tester) async {
      await tester.pumpWidget(app(const BbSkeletonList(
        row: BbSkeletonListRow(),
        semanticLabel: 'Loading history…',
      )));

      final BoxDecoration block = tester
          .widget<Container>(find.descendant(
            of: find.byType(BbSkeletonBox).first,
            matching: find.byType(Container),
          ))
          .decoration! as BoxDecoration;
      expect(block.color, AppColors.border);
      expect(find.bySemanticsLabel('Loading history…'), findsOneWidget);
    });

    testWidgets('static under reduced motion — no sweep, nothing ticking',
        (WidgetTester tester) async {
      await tester.pumpWidget(app(const BbSkeletonList(
        row: BbSkeletonCandidateRow(),
      )));

      expect(find.byType(ShaderMask), findsNothing);
      expect(tester.binding.transientCallbackCount, 0,
          reason: 'no ticker running');
    });

    testWidgets('the shimmer sweeps once every 1.2s when motion is on',
        (WidgetTester tester) async {
      await tester.pumpWidget(app(
        const BbSkeletonList(row: BbSkeletonCandidateRow(), count: 1),
        motion: true,
      ));

      expect(find.byType(ShaderMask), findsWidgets);
      Animation<double> sweep() => tester
          .widget<AnimatedBuilder>(find.descendant(
            of: find.byType(BbSkeletonMask).first,
            matching: find.byType(AnimatedBuilder),
          ))
          .animation as Animation<double>;
      final double start = sweep().value;
      await tester.pump(const Duration(milliseconds: 600));
      expect((sweep().value - start).abs(), closeTo(0.5, 0.05));
      await tester.pump(const Duration(milliseconds: 600));
      expect(sweep().value, closeTo(start, 0.05), reason: 'one cycle = 1.2s');

      await tester.pumpWidget(const SizedBox.shrink());
    });
  });

  group('skeleton → content', () {
    Widget switcher({required bool loading, bool motion = false}) => app(
          BbLoadSwitcher(
            loading: loading,
            skeleton: const BbSkeletonList(row: BbSkeletonCandidateRow()),
            child: const Text('Real rows'),
          ),
          motion: motion,
        );

    testWidgets('cross-fades in over 200ms', (WidgetTester tester) async {
      await tester.pumpWidget(switcher(loading: true, motion: true));
      await tester.pumpWidget(switcher(loading: false, motion: true));
      await tester.pump(const Duration(milliseconds: 100));

      // Mid-fade: both on stage, the content half in.
      expect(find.byType(BbSkeletonList), findsOneWidget);
      final FadeTransition fade = tester.widget<FadeTransition>(
        find
            .ancestor(
              of: find.text('Real rows'),
              matching: find.byType(FadeTransition),
            )
            .first,
      );
      expect(fade.opacity.value, inExclusiveRange(0.0, 1.0));

      await tester.pump(const Duration(milliseconds: 110));
      expect(find.byType(BbSkeletonList), findsNothing);
      expect(find.text('Real rows'), findsOneWidget);
      await tester.pumpWidget(const SizedBox.shrink());
    });

    testWidgets('is instant with animations disabled',
        (WidgetTester tester) async {
      await tester.pumpWidget(switcher(loading: true));
      await tester.pumpWidget(switcher(loading: false));
      await tester.pump();

      expect(find.byType(BbSkeletonList), findsNothing);
      expect(find.text('Real rows'), findsOneWidget);
    });

    testWidgets('rows under a fixed header fade in; later rows are just there',
        (WidgetTester tester) async {
      Widget list({required bool loading, int rows = 1}) => app(
            BbRowsReveal(
              loading: loading,
              child: Column(
                children: <Widget>[
                  for (int i = 0; i < rows; i++)
                    BbRevealFade(child: Text('row $i')),
                ],
              ),
            ),
            motion: true,
          );
      double opacityOf(String text) => tester
          .widget<FadeTransition>(find
              .ancestor(
                  of: find.text(text), matching: find.byType(FadeTransition))
              .first)
          .opacity
          .value;

      await tester.pumpWidget(list(loading: true, rows: 0));
      await tester.pumpWidget(list(loading: false));
      expect(opacityOf('row 0'), 0);
      await tester.pump(const Duration(milliseconds: 100));
      expect(opacityOf('row 0'), inExclusiveRange(0.0, 1.0));
      await tester.pump(const Duration(milliseconds: 110));
      expect(opacityOf('row 0'), 1);

      // A row built later (scrolled in, the next page) does not re-fade.
      await tester.pumpWidget(list(loading: false, rows: 2));
      expect(opacityOf('row 1'), 1);
    });
  });

  group('kept rows while a change loads', () {
    testWidgets('a stale row dims to 60% and comes back to full',
        (WidgetTester tester) async {
      double opacity() =>
          tester.widget<AnimatedOpacity>(find.byType(AnimatedOpacity)).opacity;

      await tester
          .pumpWidget(app(const BbDim(dimmed: true, child: Text('old row'))));
      expect(opacity(), 0.6);
      expect(find.text('old row'), findsOneWidget, reason: 'never hidden');

      await tester
          .pumpWidget(app(const BbDim(dimmed: false, child: Text('new row'))));
      expect(opacity(), 1);
    });

    testWidgets('a thin bar sits on top only while busy — static when reduced',
        (WidgetTester tester) async {
      await tester.pumpWidget(
          app(const BbStaleFrame(busy: false, child: Text('rows'))));
      expect(find.byKey(BbStaleFrame.barKey), findsNothing);

      await tester
          .pumpWidget(app(const BbStaleFrame(busy: true, child: Text('rows'))));
      expect(find.byKey(BbStaleFrame.barKey), findsOneWidget);
      expect(find.byType(LinearProgressIndicator), findsNothing,
          reason: 'reduced motion: a static line, nothing ticking');
      expect(tester.getSize(find.byKey(BbStaleFrame.barKey)).height,
          BbStaleFrame.barHeight);
      expect(tester.getTopLeft(find.byKey(BbStaleFrame.barKey)).dy, 0);

      await tester.pumpWidget(app(
        const BbStaleFrame(busy: true, child: Text('rows')),
        motion: true,
      ));
      expect(find.byType(LinearProgressIndicator), findsOneWidget);
      await tester.pumpWidget(const SizedBox.shrink());
    });
  });

  group('pull-to-refresh', () {
    testWidgets('brand indicator (deep blue on paper); pulling runs it',
        (WidgetTester tester) async {
      int pulls = 0;
      await tester.pumpWidget(app(BbRefreshIndicator(
        onRefresh: () async => pulls++,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          children: const <Widget>[Text('Rows')],
        ),
      )));

      final RefreshIndicator indicator =
          tester.widget<RefreshIndicator>(find.byType(RefreshIndicator));
      expect(indicator.color, AppColors.blue);
      expect(indicator.backgroundColor, AppColors.paper);

      await tester.fling(find.text('Rows'), const Offset(0, 400), 1000);
      await tester.pumpAndSettle();
      expect(pulls, 1);
    });

    testWidgets('an empty state pulls too, still centred on a 360×640 phone',
        (WidgetTester tester) async {
      phone(tester);
      int pulls = 0;
      await tester.pumpWidget(app(BbPullableFill(
        onRefresh: () async => pulls++,
        child: const Center(child: Text('Nothing here yet')),
      )));

      expect(tester.getCenter(find.text('Nothing here yet')).dy,
          moreOrLessEquals(320, epsilon: 1));
      expect(find.byType(RefreshIndicator), findsOneWidget);

      await tester.fling(
          find.text('Nothing here yet'), const Offset(0, 400), 1000);
      await tester.pumpAndSettle();
      expect(pulls, 1);
      expect(tester.takeException(), isNull);
    });

    testWidgets('a failed refresh says why; a good one stays quiet',
        (WidgetTester tester) async {
      late BuildContext ctx;
      await tester.pumpWidget(app(Builder(builder: (BuildContext c) {
        ctx = c;
        return const SizedBox.shrink();
      })));

      await refreshWithToast(ctx, () async => null);
      await tester.pump();
      expect(find.text("Couldn't refresh"), findsNothing);

      await refreshWithToast(
        ctx,
        () async => const PayerFailure(PayerFailureKind.network),
      );
      await tester.pump();
      expect(find.text("Couldn't refresh"), findsOneWidget);
      expect(find.text(const PayerFailure(PayerFailureKind.network).message),
          findsOneWidget);
    });
  });

  group('tab returns', () {
    testWidgets('a hidden view re-reads once, when it is next shown',
        (WidgetTester tester) async {
      final BbTabSignals signals = BbTabSignals();
      addTearDown(signals.dispose);
      int reads = 0;
      Widget view({required bool shown}) => app(BbTabScope(
            signals: signals,
            child: BbTabRefreshListener(
              enabled: shown,
              onRefresh: (_) => reads++,
              child: const SizedBox.shrink(),
            ),
          ));

      await tester.pumpWidget(view(shown: false));
      await tester.pump();
      signals.refresh();
      await tester.pump();
      expect(reads, 0, reason: 'a hidden view costs no request');

      await tester.pumpWidget(view(shown: true));
      await tester.pump();
      expect(reads, 1, reason: 'it missed a return, so it catches up');

      await tester.pumpWidget(view(shown: false));
      await tester.pumpWidget(view(shown: true));
      await tester.pump();
      expect(reads, 1, reason: 'once per missed return');

      signals.refresh();
      await tester.pump();
      expect(reads, 2, reason: 'on screen, a return re-reads straight away');
    });

    testWidgets('a view built by the return it hears does not read twice',
        (WidgetTester tester) async {
      final BbTabSignals signals = BbTabSignals();
      addTearDown(signals.dispose);
      int reads = 0;
      Widget view(int build) => app(BbTabScope(
            signals: signals,
            child: BbTabRefreshListener(
              key: ValueKey<int>(build),
              onRefresh: (_) => reads++,
              child: const SizedBox.shrink(),
            ),
          ));

      await tester.pumpWidget(view(0));
      await tester.pump();
      signals.refresh();
      await tester.pump();
      expect(reads, 1);

      // The return rebuilds the view (as a Jobs card's "Applicants" rebuilds
      // Find's Applicants view); the shell signals after that frame.
      WidgetsBinding.instance.addPostFrameCallback((_) => signals.refresh());
      await tester.pumpWidget(view(1));
      await tester.pump();
      expect(reads, 1, reason: 'its fresh cubit is loading already');

      signals.refresh();
      await tester.pump();
      expect(reads, 2, reason: 'later returns re-read as usual');
    });
  });

  group('automatic load-more', () {
    testWidgets('fires once after its frame, and again only when re-enabled',
        (WidgetTester tester) async {
      int loads = 0;
      Widget trigger(bool enabled) => app(BbLoadMoreTrigger(
            enabled: enabled,
            onLoadMore: () => loads++,
            child: const Text('end of list'),
          ));

      // Built inside a frame, fired after it — never during build.
      await tester.pumpWidget(trigger(true));
      expect(loads, 1);

      await tester.pumpWidget(trigger(true));
      await tester.pump();
      expect(loads, 1, reason: 'a rebuild is not a new "near the end"');

      await tester.pumpWidget(trigger(false));
      expect(loads, 1);
      await tester.pumpWidget(trigger(true));
      expect(loads, 2);
    });

    testWidgets('the load-more row fades in over 160ms',
        (WidgetTester tester) async {
      double opacity() => tester
          .widget<Opacity>(find
              .ancestor(
                of: find.byType(BbSkeletonCandidateRow),
                matching: find.byType(Opacity),
              )
              .first)
          .opacity;

      await tester.pumpWidget(app(const BbLoadMoreRow(), motion: true));
      expect(opacity(), 0);
      await tester.pump(const Duration(milliseconds: 80));
      expect(opacity(), inExclusiveRange(0.0, 1.0));
      await tester.pump(const Duration(milliseconds: 90));
      expect(opacity(), 1);
      expect(find.bySemanticsLabel('Loading more'), findsOneWidget);
      await tester.pumpWidget(const SizedBox.shrink());
    });
  });
}
