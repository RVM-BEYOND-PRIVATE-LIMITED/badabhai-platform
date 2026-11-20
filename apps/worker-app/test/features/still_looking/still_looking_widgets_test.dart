import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/features/profile_edit/domain/profile_edit_repository.dart';
import 'package:badabhai_worker_app/features/still_looking/domain/still_looking_repository.dart';
import 'package:badabhai_worker_app/features/still_looking/presentation/cubit/still_looking_cubit.dart';
import 'package:badabhai_worker_app/features/still_looking/presentation/widgets/still_looking_banner.dart';
import 'package:badabhai_worker_app/features/still_looking/presentation/widgets/still_looking_sheet.dart';
import 'package:mocktail/mocktail.dart';

class _FakeStillLookingRepository implements StillLookingRepository {
  _FakeStillLookingRepository(this.readResult);

  final StillLookingDto readResult;

  @override
  Future<StillLookingDto> read() async => readResult;

  @override
  Future<StillLookingDto> answer(StillLookingAnswer answer) async =>
      const StillLookingDto(
        due: false,
        availabilityNeedsAnswer: false,
        notRecentlyActive: false,
      );
}

class _MockProfileEditRepository extends Mock
    implements ProfileEditRepository {}

/// A repository whose read fails once (`503`), then succeeds — the seam the
/// retry strip is tested against.
class _RetryStillLookingRepository implements StillLookingRepository {
  int reads = 0;

  @override
  Future<StillLookingDto> read() async {
    reads++;
    if (reads == 1) throw const ServerFailure(503);
    return const StillLookingDto(
      due: false,
      availabilityNeedsAnswer: false,
      notRecentlyActive: false,
    );
  }

  @override
  Future<StillLookingDto> answer(StillLookingAnswer answer) async =>
      const StillLookingDto(
        due: false,
        availabilityNeedsAnswer: false,
        notRecentlyActive: false,
      );
}

void _setPhone(WidgetTester tester) {
  tester.view.physicalSize = const Size(360, 640);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
}

void main() {
  setUpAll(() => registerFallbackValue(<String, dynamic>{}));

  setUp(() => GoogleFonts.config.allowRuntimeFetching = false);

  testWidgets('the inactivity banner holds at 360 dp', (
    WidgetTester tester,
  ) async {
    _setPhone(tester);
    final StillLookingCubit cubit = StillLookingCubit(
      repository: _FakeStillLookingRepository(
        const StillLookingDto(
          due: false,
          availabilityNeedsAnswer: false,
          lastActiveOn: '2026-09-01',
          notRecentlyActive: true,
        ),
      ),
      profileRepository: _MockProfileEditRepository(),
    );
    await cubit.load();
    addTearDown(cubit.close);

    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light(),
        home: Scaffold(
          body: BlocProvider<StillLookingCubit>.value(
            value: cubit,
            child: const StillLookingInactiveBanner(),
          ),
        ),
      ),
    );
    await tester.pump();

    expect(tester.takeException(), isNull);
    expect(find.byKey(kStillLookingBannerKey), findsOneWidget);
    expect(find.text(kStillLookingInactiveBannerText), findsOneWidget);
    expect(find.text(kStillLookingInactiveBannerAction), findsOneWidget);
  });

  testWidgets('a 503 shows a retry, and it clears once the read succeeds', (
    WidgetTester tester,
  ) async {
    _setPhone(tester);
    final _RetryStillLookingRepository repo = _RetryStillLookingRepository();
    final StillLookingCubit cubit = StillLookingCubit(
      repository: repo,
      profileRepository: _MockProfileEditRepository(),
    );
    await cubit.load();
    addTearDown(cubit.close);

    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light(),
        home: Scaffold(
          body: BlocProvider<StillLookingCubit>.value(
            value: cubit,
            child: const StillLookingInactiveBanner(),
          ),
        ),
      ),
    );
    await tester.pump();

    expect(tester.takeException(), isNull);
    expect(find.byKey(kStillLookingRetryKey), findsOneWidget);
    expect(find.text(kStillLookingRetryText), findsOneWidget);

    await tester.tap(find.text(kStillLookingRetryAction));
    await tester.pump();
    await tester.pump();

    expect(repo.reads, 2);
    expect(find.byKey(kStillLookingRetryKey), findsNothing);
  });

  testWidgets('the monthly card holds at 360 dp and renders the availability '
      'chips the server served', (WidgetTester tester) async {
    _setPhone(tester);
    final _MockProfileEditRepository profile = _MockProfileEditRepository();
    when(() => profile.loadWorkPreferenceOptions()).thenAnswer(
      (_) async => const WorkPrefOptionsDto(
        languages: <String, String>{},
        documentsReady: <String, String>{},
        jobType: <String, String>{},
        shift: <String, String>{},
        availabilityStatus: <String, String>{
          'join_now': 'Can join now',
          'in_15_days': 'Can join in 15 days',
          'in_30_days': 'Can join in 30 days',
          'working_open': 'Working, open to a better offer',
        },
      ),
    );
    when(
      () => profile.loadWorkPreferences(),
    ).thenAnswer((_) async => const WorkPreferencesDto());
    final StillLookingCubit cubit = StillLookingCubit(
      repository: _FakeStillLookingRepository(
        const StillLookingDto(
          due: true,
          checkId: 'check-1',
          availabilityNeedsAnswer: true,
          notRecentlyActive: false,
        ),
      ),
      profileRepository: profile,
    );
    await cubit.load();
    addTearDown(cubit.close);

    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light(),
        home: BlocProvider<StillLookingCubit>.value(
          value: cubit,
          child: const Scaffold(
            body: SingleChildScrollView(
              padding: EdgeInsets.all(16),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  StillLookingSheetBody(),
                  StillLookingSheetActions(),
                ],
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pump();

    expect(tester.takeException(), isNull);
    expect(find.text(kStillLookingTitle), findsOneWidget);
    expect(find.text(kStillLookingAvailabilityTitle), findsOneWidget);
    expect(find.text('Can join now'), findsOneWidget);
    expect(find.text(kStillLookingYesLabel), findsOneWidget);
    expect(find.text(kStillLookingNotNowLabel), findsOneWidget);
    expect(find.text(kStillLookingNotNowNote), findsOneWidget);

    await tester.tap(find.text('Can join now'));
    await tester.pump();
    expect(cubit.state.selectedAvailability, 'join_now');
  });
}
