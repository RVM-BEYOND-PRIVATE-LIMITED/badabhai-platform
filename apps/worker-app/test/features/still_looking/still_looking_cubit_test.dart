import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/features/profile_edit/domain/profile_edit_repository.dart';
import 'package:badabhai_worker_app/features/still_looking/domain/still_looking_repository.dart';
import 'package:badabhai_worker_app/features/still_looking/presentation/cubit/still_looking_cubit.dart';

class _FakeStillLookingRepository implements StillLookingRepository {
  StillLookingDto readResult = const StillLookingDto(
    due: true,
    checkId: 'check-1',
    availabilityNeedsAnswer: false,
    lastActiveOn: '2026-11-20',
    notRecentlyActive: false,
  );
  Object? readError;

  StillLookingDto answerResult = const StillLookingDto(
    due: false,
    availabilityNeedsAnswer: false,
    lastActiveOn: '2026-11-20',
    notRecentlyActive: false,
  );
  Object? answerError;

  StillLookingAnswer? lastAnswer;

  @override
  Future<StillLookingDto> read() async {
    if (readError != null) throw readError!;
    return readResult;
  }

  @override
  Future<StillLookingDto> answer(StillLookingAnswer answer) async {
    lastAnswer = answer;
    if (answerError != null) throw answerError!;
    return answerResult;
  }
}

class _MockProfileEditRepository extends Mock
    implements ProfileEditRepository {}

void main() {
  late _FakeStillLookingRepository repo;
  late _MockProfileEditRepository profile;
  late StillLookingCubit cubit;

  setUpAll(() => registerFallbackValue(<String, dynamic>{}));

  setUp(() {
    repo = _FakeStillLookingRepository();
    profile = _MockProfileEditRepository();
    when(() => profile.saveWorkPreferences(any())).thenAnswer((_) async {});
    cubit = StillLookingCubit(repository: repo, profileRepository: profile);
  });

  tearDown(() async => cubit.close());

  test('load renders the server facts', () async {
    await cubit.load();
    expect(cubit.state.status, StillLookingStatus.ready);
    expect(cubit.state.due, isTrue);
    expect(cubit.state.dto?.checkId, 'check-1');
    expect(cubit.state.dto?.lastActiveOn, '2026-11-20');
  });

  test('a 404 means the switch is off — nothing renders', () async {
    repo.readError = const ServerFailure(404);
    await cubit.load();
    expect(cubit.state.status, StillLookingStatus.hidden);
    expect(cubit.state.due, isFalse);
  });

  test('a 503 is retryable and renders no control', () async {
    repo.readError = const ServerFailure(503);
    await cubit.load();
    expect(cubit.state.status, StillLookingStatus.failed);
    expect(cubit.state.dto, isNull);
  });

  test('the availability re-ask uses the SERVER dictionary', () async {
    repo.readResult = const StillLookingDto(
      due: true,
      availabilityNeedsAnswer: true,
      notRecentlyActive: false,
    );
    when(() => profile.loadWorkPreferenceOptions()).thenAnswer(
      (_) async => const WorkPrefOptionsDto(
        languages: <String, String>{},
        documentsReady: <String, String>{},
        jobType: <String, String>{},
        shift: <String, String>{},
        availabilityStatus: <String, String>{
          'join_now': 'Can join now',
          'in_15_days': 'Can join in 15 days',
        },
      ),
    );
    when(() => profile.loadWorkPreferences()).thenAnswer(
      (_) async => const WorkPreferencesDto(
        availability: WorkAvailabilityDto(
          status: 'immediate',
          availableFrom: '2026-12-01',
          noticeDays: 30,
        ),
      ),
    );

    await cubit.load();

    expect(cubit.state.showAvailabilityAsk, isTrue);
    expect(cubit.state.availabilityOptions.keys, <String>[
      'join_now',
      'in_15_days',
    ]);
  });

  test('a failed options read degrades to the three answers only', () async {
    repo.readResult = const StillLookingDto(
      due: true,
      availabilityNeedsAnswer: true,
      notRecentlyActive: false,
    );
    when(
      () => profile.loadWorkPreferenceOptions(),
    ).thenThrow(const NetworkFailure());

    await cubit.load();

    expect(cubit.state.status, StillLookingStatus.ready);
    expect(cubit.state.due, isTrue);
    expect(cubit.state.showAvailabilityAsk, isFalse);
  });

  test('answer posts the wire answer and redraws from the reply', () async {
    await cubit.load();
    await cubit.answer(StillLookingAnswer.notNow);

    expect(repo.lastAnswer, StillLookingAnswer.notNow);
    expect(cubit.state.answered, isTrue);
    expect(cubit.state.due, isFalse);
  });

  test('a picked availability is saved BEFORE the answer, preserving stored '
      'facts', () async {
    repo.readResult = const StillLookingDto(
      due: true,
      availabilityNeedsAnswer: true,
      notRecentlyActive: false,
    );
    when(() => profile.loadWorkPreferenceOptions()).thenAnswer(
      (_) async => const WorkPrefOptionsDto(
        languages: <String, String>{},
        documentsReady: <String, String>{},
        jobType: <String, String>{},
        shift: <String, String>{},
        availabilityStatus: <String, String>{'join_now': 'Can join now'},
      ),
    );
    when(() => profile.loadWorkPreferences()).thenAnswer(
      (_) async => const WorkPreferencesDto(
        availability: WorkAvailabilityDto(
          status: 'immediate',
          availableFrom: '2026-12-01',
          noticeDays: 30,
        ),
      ),
    );
    await cubit.load();

    cubit.selectAvailability('join_now');
    await cubit.answer(StillLookingAnswer.yes);

    final Map<String, dynamic> body =
        verify(() => profile.saveWorkPreferences(captureAny())).captured.single
            as Map<String, dynamic>;
    expect(body['touched_only'], isTrue);
    final Map<String, dynamic> availability =
        body['availability'] as Map<String, dynamic>;
    expect(availability['status'], 'join_now');
    expect(availability['available_from'], '2026-12-01');
    expect(availability['notice_period_days'], 30);
    expect(repo.lastAnswer, StillLookingAnswer.yes);
  });

  test('a failed availability save keeps the answer from being sent', () async {
    repo.readResult = const StillLookingDto(
      due: true,
      availabilityNeedsAnswer: true,
      notRecentlyActive: false,
    );
    when(() => profile.loadWorkPreferenceOptions()).thenAnswer(
      (_) async => const WorkPrefOptionsDto(
        languages: <String, String>{},
        documentsReady: <String, String>{},
        jobType: <String, String>{},
        shift: <String, String>{},
        availabilityStatus: <String, String>{'join_now': 'Can join now'},
      ),
    );
    when(
      () => profile.loadWorkPreferences(),
    ).thenAnswer((_) async => const WorkPreferencesDto());
    when(
      () => profile.saveWorkPreferences(any()),
    ).thenThrow(const InvalidRequestFailure());
    await cubit.load();

    cubit.selectAvailability('join_now');
    await cubit.answer(StillLookingAnswer.yes);

    expect(repo.lastAnswer, isNull);
    expect(cubit.state.answered, isFalse);
    expect(cubit.state.failure, isA<InvalidRequestFailure>());
  });
}
