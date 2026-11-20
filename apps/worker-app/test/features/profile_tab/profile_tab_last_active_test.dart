import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart';
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/nav/tab_focus.dart';
import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/features/profile_tab/domain/profile_summary.dart';
import 'package:badabhai_worker_app/features/profile_tab/domain/profile_summary_repository.dart';
import 'package:badabhai_worker_app/features/profile_tab/presentation/cubit/profile_tab_cubit.dart';
import 'package:badabhai_worker_app/features/profile_tab/presentation/profile_tab_screen.dart';
import 'package:badabhai_worker_app/features/still_looking/domain/still_looking_repository.dart';

class _MockProfileSummaryRepository extends Mock
    implements ProfileSummaryRepository {}

class _FakeStillLookingRepository implements StillLookingRepository {
  _FakeStillLookingRepository(this.result);

  final StillLookingDto result;

  @override
  Future<StillLookingDto> read() async => result;

  @override
  Future<StillLookingDto> answer(StillLookingAnswer answer) async => result;
}

void main() {
  setUp(() {
    GoogleFonts.config.allowRuntimeFetching = false;
  });

  testWidgets('the server last-active day prints on the Profile tab', (
    WidgetTester tester,
  ) async {
    await locator.reset();
    final _MockProfileSummaryRepository summary =
        _MockProfileSummaryRepository();
    when(
      () => summary.summary(includeDisplayExtras: true),
    ).thenAnswer((_) async => const ProfileSummary(strengthSignals: 1));
    locator.registerFactory<ProfileTabCubit>(
      () => ProfileTabCubit(
        summary,
        stillLooking: _FakeStillLookingRepository(
          const StillLookingDto(
            due: false,
            availabilityNeedsAnswer: false,
            lastActiveOn: '2026-09-01',
            notRecentlyActive: false,
          ),
        ),
      ),
    );
    locator.registerLazySingleton<TabFocus>(() => TabFocus());

    tester.view.physicalSize = const Size(900, 1900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(locator.reset);

    await tester.pumpWidget(
      MaterialApp(theme: AppTheme.light(), home: const ProfileTabScreen()),
    );
    await tester.pumpAndSettle();

    expect(find.text('Last active'), findsOneWidget);
    expect(find.text('1 Sep 2026'), findsOneWidget);
  });

  testWidgets('no last-active row while the server sends none', (
    WidgetTester tester,
  ) async {
    await locator.reset();
    final _MockProfileSummaryRepository summary =
        _MockProfileSummaryRepository();
    when(
      () => summary.summary(includeDisplayExtras: true),
    ).thenAnswer((_) async => const ProfileSummary(strengthSignals: 1));
    locator.registerFactory<ProfileTabCubit>(
      () => ProfileTabCubit(
        summary,
        stillLooking: _FakeStillLookingRepository(
          const StillLookingDto(
            due: false,
            availabilityNeedsAnswer: false,
            notRecentlyActive: false,
          ),
        ),
      ),
    );
    locator.registerLazySingleton<TabFocus>(() => TabFocus());

    tester.view.physicalSize = const Size(900, 1900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(locator.reset);

    await tester.pumpWidget(
      MaterialApp(theme: AppTheme.light(), home: const ProfileTabScreen()),
    );
    await tester.pumpAndSettle();

    expect(find.text('Last active'), findsNothing);
  });
}
