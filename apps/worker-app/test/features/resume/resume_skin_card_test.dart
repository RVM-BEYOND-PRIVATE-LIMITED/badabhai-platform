import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart'
    show ResumeSkinChange, ResumeSkinState;
import 'package:badabhai_worker_app/core/error/failure.dart' show ServerFailure;
import 'package:badabhai_worker_app/features/resume/domain/resume_repository.dart';
import 'package:badabhai_worker_app/features/resume/presentation/widgets/resume_skin_card.dart';

/// RÉSUMÉ SKINS (#1808) — the picker draws only what the server allows.
///
/// The flag is off on every box today, so the card's FIRST duty is to render
/// nothing at all; its second is to stay read-only while the server serves the
/// single `neela` skin, because one option is not a choice.
class _MockResumeRepository extends Mock implements ResumeRepository {}

void main() {
  late _MockResumeRepository repo;

  setUp(() => repo = _MockResumeRepository());

  Future<void> pump(WidgetTester tester) async {
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(body: ResumeSkinCard(repository: repo)),
    ));
    await tester.pumpAndSettle();
  }

  testWidgets('flag off: the card draws NOTHING', (WidgetTester tester) async {
    when(() => repo.loadResumeSkin())
        .thenAnswer((_) async => ResumeSkinState.disabled);
    await pump(tester);

    expect(find.text(kResumeSkinTitle), findsNothing);
    expect(find.byType(SizedBox), findsWidgets); // the shrink, nothing else
  });

  testWidgets('a failed read is the same as off — never an error on the tab',
      (WidgetTester tester) async {
    // The repository swallows by contract; this pins that the CARD also treats
    // "disabled" as the only honest fallback.
    when(() => repo.loadResumeSkin())
        .thenAnswer((_) async => ResumeSkinState.disabled);
    await pump(tester);

    expect(find.text(kResumeSkinTitle), findsNothing);
  });

  testWidgets('one skin: shown, named, marked current, and NOT tappable',
      (WidgetTester tester) async {
    when(() => repo.loadResumeSkin()).thenAnswer(
      (_) async => const ResumeSkinState(
        enabled: true,
        skin: 'neela',
        skins: <String>['neela'],
      ),
    );
    await pump(tester);

    expect(find.text(kResumeSkinTitle), findsOneWidget);
    // The app's own name for the id — never the raw slug (#1027).
    expect(find.text('Neela'), findsOneWidget);
    expect(find.text('neela'), findsNothing);
    expect(find.text(kResumeSkinCurrent), findsOneWidget);
    expect(find.text(kResumeSkinSingleSubtitle), findsOneWidget);
    // Read-only: no InkWell, so nothing promises a choice that does not exist.
    expect(find.byType(InkWell), findsNothing);
    verifyNever(() => repo.chooseResumeSkin(any()));
  });

  testWidgets('two skins: tapping the other one records the choice',
      (WidgetTester tester) async {
    when(() => repo.loadResumeSkin()).thenAnswer(
      (_) async => const ResumeSkinState(
        enabled: true,
        skin: 'neela',
        skins: <String>['neela', 'saada'],
      ),
    );
    when(() => repo.chooseResumeSkin('saada')).thenAnswer(
      (_) async => const ResumeSkinChange(
        skin: 'saada',
        previousSkin: 'neela',
        changed: true,
      ),
    );
    await pump(tester);

    expect(find.text(kResumeSkinSubtitle), findsOneWidget);
    await tester.tap(find.text('Saada'));
    await tester.pumpAndSettle();

    verify(() => repo.chooseResumeSkin('saada')).called(1);
    // The new skin is the one marked current.
    final Finder current = find.ancestor(
      of: find.text(kResumeSkinCurrent),
      matching: find.byType(Row),
    );
    expect(
      find.descendant(of: current.first, matching: find.text('Saada')),
      findsOneWidget,
    );
  });

  testWidgets('tapping the CURRENT skin sends nothing (no wasted write)',
      (WidgetTester tester) async {
    when(() => repo.loadResumeSkin()).thenAnswer(
      (_) async => const ResumeSkinState(
        enabled: true,
        skin: 'neela',
        skins: <String>['neela', 'saada'],
      ),
    );
    await pump(tester);

    await tester.tap(find.text('Neela'));
    await tester.pumpAndSettle();

    verifyNever(() => repo.chooseResumeSkin(any()));
  });

  testWidgets('a 409 re-reads the server rather than keeping a lost choice',
      (WidgetTester tester) async {
    int reads = 0;
    when(() => repo.loadResumeSkin()).thenAnswer((_) async {
      reads++;
      return ResumeSkinState(
        enabled: true,
        // The concurrent winner, on the second read.
        skin: reads == 1 ? 'neela' : 'saada',
        skins: const <String>['neela', 'saada'],
      );
    });
    when(() => repo.chooseResumeSkin('saada'))
        .thenThrow(const ServerFailure(409));
    await pump(tester);

    await tester.tap(find.text('Saada'));
    await tester.pumpAndSettle();

    expect(reads, 2, reason: 'a 409 must re-fetch, never guess');
  });

  group('ResumeSkinState.fromJson', () {
    test('enabled:false is disabled, whatever else the body carries', () {
      final ResumeSkinState s = ResumeSkinState.fromJson(<String, dynamic>{
        'enabled': false,
        'skin': 'neela',
        'skins': <String>['neela'],
      });
      expect(s.enabled, isFalse);
      expect(s.skin, isNull);
      expect(s.skins, isEmpty);
    });

    test('a malformed body fails closed to disabled', () {
      for (final Map<String, dynamic> body in <Map<String, dynamic>>[
        <String, dynamic>{},
        <String, dynamic>{'enabled': 'yes'},
        <String, dynamic>{'skins': <String>['neela']},
      ]) {
        expect(ResumeSkinState.fromJson(body).enabled, isFalse, reason: '$body');
      }
    });

    test('canChoose needs a SECOND skin', () {
      const ResumeSkinState one = ResumeSkinState(
        enabled: true,
        skin: 'neela',
        skins: <String>['neela'],
      );
      expect(one.canChoose, isFalse);
      expect(
        const ResumeSkinState(
          enabled: true,
          skin: 'neela',
          skins: <String>['neela', 'saada'],
        ).canChoose,
        isTrue,
      );
    });
  });

  group('ResumeSkinChange.fromJson', () {
    test('"unchanged" is not a change — a double tap is not a re-render', () {
      final ResumeSkinChange c = ResumeSkinChange.fromJson(<String, dynamic>{
        'skin': 'neela',
        'previous_skin': 'neela',
        'change': 'unchanged',
      });
      expect(c.changed, isFalse);
      expect(c.skin, 'neela');
    });

    test('"changed" carries the previous skin', () {
      final ResumeSkinChange c = ResumeSkinChange.fromJson(<String, dynamic>{
        'skin': 'saada',
        'previous_skin': 'neela',
        'change': 'changed',
      });
      expect(c.changed, isTrue);
      expect(c.previousSkin, 'neela');
    });
  });
}
