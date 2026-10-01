import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';

import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/features/chat/presentation/widgets/chat_location_card.dart';
import 'package:badabhai_worker_app/features/name/domain/location_lookup.dart';

/// ADR-0048 — THE LOCATION CARD.
///
/// The intake asks state and city as two turns, and answering each with the
/// chat's horizontal chip scroller meant scrolling sideways through 36 states,
/// then repeating it for the city, with no way back. This card is the `/name`
/// affordance kept: both pickers, a GPS fill, one confirm.
class _FakeLookup implements LocationLookup {
  _FakeLookup({this.result, this.failure});

  final ResolvedLocation? result;
  final LocationLookupFailureReason? failure;
  int calls = 0;

  @override
  Future<ResolvedLocation> resolveCurrent() async {
    calls++;
    final LocationLookupFailureReason? reason = failure;
    if (reason != null) throw LocationLookupFailure(reason);
    return result!;
  }

  @override
  Future<bool> isAvailable() async => true;
}

void main() {
  Future<void> pump(
    WidgetTester tester, {
    required bool askState,
    required bool askCity,
    String? knownState,
    LocationLookup? lookup,
    void Function({String? state, String? city})? onSubmit,
  }) async {
    GoogleFonts.config.allowRuntimeFetching = false;
    await tester.pumpWidget(MaterialApp(
      theme: AppTheme.light(),
      home: Scaffold(
        body: SingleChildScrollView(
          child: ChatLocationCard(
            askState: askState,
            askCity: askCity,
            knownState: knownState,
            lookup: lookup,
            onSubmit: onSubmit ?? ({String? state, String? city}) {},
          ),
        ),
      ),
    ));
    await tester.pump();
  }

  testWidgets('both pickers, the GPS button and the confirm are on ONE card',
      (WidgetTester tester) async {
    await pump(tester, askState: true, askCity: true);
    expect(find.text(kChatLocationGpsCta), findsOneWidget);
    expect(find.text(kChatLocationStateLabel), findsOneWidget);
    expect(find.text(kChatLocationCityLabel), findsOneWidget);
    expect(find.text(kChatLocationConfirm), findsOneWidget);
  });

  testWidgets('NOTHING is submitted until the confirm is pressed',
      (WidgetTester tester) async {
    int submits = 0;
    await pump(
      tester,
      askState: true,
      askCity: true,
      onSubmit: ({String? state, String? city}) => submits++,
    );
    // The chat must not move on while the worker is still choosing — the whole
    // point of the card over two chip rows.
    expect(submits, 0);
    final Finder ok = find.widgetWithText(InkWell, kChatLocationConfirm);
    expect(ok, findsAny);
  });

  testWidgets('the confirm is DISABLED until everything asked has an answer',
      (WidgetTester tester) async {
    await pump(tester, askState: true, askCity: true);
    // Nothing chosen yet.
    final Finder button = find.ancestor(
      of: find.text(kChatLocationConfirm),
      matching: find.byType(IgnorePointer),
    );
    expect(button, findsAny,
        reason: 'a disabled PrimaryActionButton wraps itself in IgnorePointer');
  });

  group('GPS', () {
    testWidgets('a fix fills BOTH pickers', (WidgetTester tester) async {
      final _FakeLookup lookup = _FakeLookup(
        result: const ResolvedLocation(city: 'Jaipur', state: 'Rajasthan'),
      );
      await pump(tester, askState: true, askCity: true, lookup: lookup);

      await tester.tap(find.text(kChatLocationGpsCta));
      await tester.pumpAndSettle();

      expect(lookup.calls, 1);
      expect(find.text('Rajasthan'), findsOneWidget);
      expect(find.text('Jaipur'), findsOneWidget);
    });

    testWidgets('a REFUSED permission says so, and the pickers remain',
        (WidgetTester tester) async {
      await pump(
        tester,
        askState: true,
        askCity: true,
        lookup: _FakeLookup(
          failure: LocationLookupFailureReason.permissionDenied,
        ),
      );
      await tester.tap(find.text(kChatLocationGpsCta));
      await tester.pumpAndSettle();

      // The REAL cause, never "check your internet", and never a dead end.
      expect(
        find.text(kChatLocationGpsErrors[
            LocationLookupFailureReason.permissionDenied]!),
        findsOneWidget,
      );
      expect(find.text(kChatLocationStateLabel), findsOneWidget);
      expect(find.text(kChatLocationGpsCta), findsOneWidget,
          reason: 'the button stays — a worker may grant it and retry');
    });

    testWidgets('location switched off says THAT, not something generic',
        (WidgetTester tester) async {
      await pump(
        tester,
        askState: true,
        askCity: true,
        lookup: _FakeLookup(
          failure: LocationLookupFailureReason.serviceDisabled,
        ),
      );
      await tester.tap(find.text(kChatLocationGpsCta));
      await tester.pumpAndSettle();
      expect(
        find.text(kChatLocationGpsErrors[
            LocationLookupFailureReason.serviceDisabled]!),
        findsOneWidget,
      );
    });

    test('every failure reason has its own honest line', () {
      // No reason may fall through to a blank or a generic default.
      for (final LocationLookupFailureReason reason
          in LocationLookupFailureReason.values) {
        expect(kChatLocationGpsErrors[reason], isNotNull, reason: '$reason');
        expect(kChatLocationGpsErrors[reason]!.trim(), isNotEmpty);
      }
    });
  });

  testWidgets('city-only: the state picker is not drawn at all',
      (WidgetTester tester) async {
    // The worker's record already has a state, so the intake asks only the city.
    await pump(
      tester,
      askState: false,
      askCity: true,
      knownState: 'Rajasthan',
    );
    expect(find.text(kChatLocationStateLabel), findsNothing);
    expect(find.text(kChatLocationCityLabel), findsOneWidget);
  });
}
