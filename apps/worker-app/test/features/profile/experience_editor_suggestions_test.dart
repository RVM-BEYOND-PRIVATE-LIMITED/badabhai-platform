import 'package:badabhai_worker_app/core/api/api_client.dart'
    show WorkPrefOptionsDto;
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/features/profile/domain/profile_repository.dart';
import 'package:badabhai_worker_app/features/profile/presentation/cubit/profile_cubit.dart';
import 'package:badabhai_worker_app/features/profile/presentation/experience_editor_screen.dart';
import 'package:badabhai_worker_app/features/profile_tab/domain/profile_summary_repository.dart';
import 'package:badabhai_worker_app/features/trade_form/domain/trade_form_models.dart';
import 'package:badabhai_worker_app/features/trade_form/domain/trade_form_repository.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import '../../support/kit_matrix.dart';

/// #1516 — the chat road's experience editor reuses the Work History page, so
/// it offers the same unconfirmed résumé/chat jobs. It draws only the rows
/// added this session, never the stored ones, so the cubit filters out the
/// suggestions that are already a saved job before the editor sees them.
class _MockProfileRepository extends Mock implements ProfileRepository {}

class _MockSummaryRepository extends Mock
    implements ProfileSummaryRepository {}

class _MockTradeFormRepository extends Mock implements TradeFormRepository {}

const TradeFormEmploymentSuggestion _chatWelder = TradeFormEmploymentSuggestion(
  source: TradeFormEmploymentSuggestionSource.chat,
  roleLabel: 'Welder',
  workDone: 'Joint banate the',
);

const TradeFormEmploymentSuggestion _resumeFitter =
    TradeFormEmploymentSuggestion(
  source: TradeFormEmploymentSuggestionSource.resume,
  employerName: 'Acme',
  roleLabel: 'Fitter',
);

Widget _editor({
  Future<List<TradeFormEmploymentSuggestion>> Function()? loadSuggestions,
  Future<void> Function(List<TradeFormEmploymentEntry>)? onSave,
}) {
  return kitTestApp(
    ExperienceEditorScreen(
      initialEntries: const <TradeFormEmploymentEntry>[],
      loadOptions: () async => const WorkPrefOptionsDto(
        languages: <String, String>{},
        documentsReady: <String, String>{},
        jobType: <String, String>{},
        shift: <String, String>{},
      ),
      onSave: onSave ?? (_) async {},
      loadSuggestions: loadSuggestions,
    ),
  );
}

void main() {
  group('ProfileCubit.loadEmploymentSuggestions', () {
    test('offers only the suggestions that are not already a saved job',
        () async {
      final _MockTradeFormRepository tradeForm = _MockTradeFormRepository();
      when(() => tradeForm.loadSavedEmployment()).thenAnswer(
        (_) async => const TradeFormStoredEmployment(
          entries: <TradeFormEmploymentEntry>[
            TradeFormEmploymentEntry(employerName: 'Acme', roleLabel: 'Fitter'),
          ],
          expectedExistingCount: 1,
          suggestions: <TradeFormEmploymentSuggestion>[
            _resumeFitter,
            _chatWelder,
          ],
        ),
      );
      final ProfileCubit cubit = ProfileCubit(
        _MockProfileRepository(),
        _MockSummaryRepository(),
        tradeFormRepo: tradeForm,
      );
      addTearDown(cubit.close);

      expect(
        await cubit.loadEmploymentSuggestions(),
        const <TradeFormEmploymentSuggestion>[_chatWelder],
      );
    });

    test('a failed read propagates its typed Failure', () async {
      final _MockTradeFormRepository tradeForm = _MockTradeFormRepository();
      when(() => tradeForm.loadSavedEmployment())
          .thenThrow(const NetworkFailure());
      final ProfileCubit cubit = ProfileCubit(
        _MockProfileRepository(),
        _MockSummaryRepository(),
        tradeFormRepo: tradeForm,
      );
      addTearDown(cubit.close);

      await expectLater(
        cubit.loadEmploymentSuggestions(),
        throwsA(isA<NetworkFailure>()),
      );
    });
  });

  group('ExperienceEditorScreen suggestions', () {
    testWidgets('fetched after the editor opens and offered as cards',
        (WidgetTester tester) async {
      setKitSurface(tester, const Size(420, 2400));
      await tester.pumpWidget(
        _editor(
          loadSuggestions: () async =>
              const <TradeFormEmploymentSuggestion>[_chatWelder],
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Kya ye aapka kaam tha?'), findsOneWidget);
      expect(find.text('Aapki chat se'), findsOneWidget);
      expect(find.text('Welder'), findsOneWidget);
    });

    testWidgets('a failed fetch offers nothing and leaves the editor usable',
        (WidgetTester tester) async {
      setKitSurface(tester, const Size(420, 2400));
      await tester.pumpWidget(
        _editor(loadSuggestions: () async => throw const NetworkFailure()),
      );
      await tester.pumpAndSettle();

      expect(find.text('Kya ye aapka kaam tha?'), findsNothing);
      expect(find.text('Aur ek jagah jodein'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('an accepted suggestion is saved only by "Save karein"',
        (WidgetTester tester) async {
      setKitSurface(tester, const Size(420, 2400));
      final List<List<TradeFormEmploymentEntry>> saved =
          <List<TradeFormEmploymentEntry>>[];
      await tester.pumpWidget(
        _editor(
          loadSuggestions: () async =>
              const <TradeFormEmploymentSuggestion>[_chatWelder],
          onSave: (List<TradeFormEmploymentEntry> e) async => saved.add(e),
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.text('Jodein'));
      await tester.pumpAndSettle();
      expect(saved, isEmpty);

      // The company a chat suggestion never has is still required.
      await tester.tap(find.text('Save karein'));
      await tester.pumpAndSettle();
      expect(saved, isEmpty);
      expect(find.text('Company ka naam likhein.'), findsOneWidget);
    });
  });
}
