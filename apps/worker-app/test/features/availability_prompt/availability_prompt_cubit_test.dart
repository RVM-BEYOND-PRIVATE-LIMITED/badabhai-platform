import 'package:bloc_test/bloc_test.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart'
    show WorkAvailabilityDto;
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/features/availability_prompt/domain/availability_prompt_gate.dart';
import 'package:badabhai_worker_app/features/availability_prompt/presentation/cubit/availability_prompt_cubit.dart';
import 'package:badabhai_worker_app/features/profile_edit/domain/profile_edit_repository.dart';

class _MockProfileEditRepository extends Mock
    implements ProfileEditRepository {}

const AvailabilityPrompt _prompt = AvailabilityPrompt(
  options: <String, String>{
    'immediate': 'Immediately',
    'within_week': 'Within a week',
    'within_month': 'Within a month',
    'serving_notice': 'Serving notice',
  },
  stored: WorkAvailabilityDto(availableFrom: '2026-12-01', noticeDays: 30),
);

void main() {
  late _MockProfileEditRepository repo;

  setUpAll(() => registerFallbackValue(<String, dynamic>{}));

  setUp(() {
    repo = _MockProfileEditRepository();
    when(() => repo.saveWorkPreferences(any())).thenAnswer((_) async {});
  });

  AvailabilityPromptCubit build() =>
      AvailabilityPromptCubit(repository: repo, prompt: _prompt);

  test('starts choosing, with nothing picked and save off', () {
    final AvailabilityPromptCubit cubit = build();
    expect(cubit.state, const AvailabilityPromptState());
    expect(cubit.state.canSave, isFalse);
    cubit.close();
  });

  blocTest<AvailabilityPromptCubit, AvailabilityPromptState>(
    'picking a served choice selects it and turns save on',
    build: build,
    act: (AvailabilityPromptCubit c) => c.select('within_week'),
    expect: () => <AvailabilityPromptState>[
      const AvailabilityPromptState(selected: 'within_week'),
    ],
    verify: (AvailabilityPromptCubit c) => expect(c.state.canSave, isTrue),
  );

  blocTest<AvailabilityPromptCubit, AvailabilityPromptState>(
    'a slug the server did not serve can never be picked',
    build: build,
    act: (AvailabilityPromptCubit c) => c.select('not_a_served_choice'),
    expect: () => <AvailabilityPromptState>[],
  );

  blocTest<AvailabilityPromptCubit, AvailabilityPromptState>(
    'save without a pick writes nothing',
    build: build,
    act: (AvailabilityPromptCubit c) => c.save(),
    expect: () => <AvailabilityPromptState>[],
    verify: (_) => verifyNever(() => repo.saveWorkPreferences(any())),
  );

  blocTest<AvailabilityPromptCubit, AvailabilityPromptState>(
    'save writes ONLY the availability, keeping the stored date and notice',
    build: build,
    act: (AvailabilityPromptCubit c) async {
      c.select('serving_notice');
      await c.save();
    },
    expect: () => <AvailabilityPromptState>[
      const AvailabilityPromptState(selected: 'serving_notice'),
      const AvailabilityPromptState(
        status: AvailabilityPromptStatus.saving,
        selected: 'serving_notice',
      ),
      const AvailabilityPromptState(
        status: AvailabilityPromptStatus.saved,
        selected: 'serving_notice',
      ),
    ],
    verify: (_) => verify(
      () => repo.saveWorkPreferences(<String, dynamic>{
        'touched_only': true,
        'availability': <String, dynamic>{
          'status': 'serving_notice',
          'available_from': '2026-12-01',
          'notice_period_days': 30,
        },
      }),
    ).called(1),
  );

  blocTest<AvailabilityPromptCubit, AvailabilityPromptState>(
    'a save error keeps the sheet: back to choosing, with the pick and the '
    'reason',
    build: () {
      when(
        () => repo.saveWorkPreferences(any()),
      ).thenThrow(const NetworkFailure());
      return build();
    },
    act: (AvailabilityPromptCubit c) async {
      c.select('immediate');
      await c.save();
    },
    expect: () => <AvailabilityPromptState>[
      const AvailabilityPromptState(selected: 'immediate'),
      const AvailabilityPromptState(
        status: AvailabilityPromptStatus.saving,
        selected: 'immediate',
      ),
      const AvailabilityPromptState(
        selected: 'immediate',
        failure: NetworkFailure(),
      ),
    ],
    verify: (AvailabilityPromptCubit c) =>
        expect(c.state.canSave, isTrue, reason: 'a retry is one tap away'),
  );

  blocTest<AvailabilityPromptCubit, AvailabilityPromptState>(
    'a 400 that names the input is kept as the reason',
    build: () {
      when(() => repo.saveWorkPreferences(any())).thenThrow(
        const InvalidRequestFailure('availability.status is not allowed'),
      );
      return build();
    },
    act: (AvailabilityPromptCubit c) async {
      c.select('within_month');
      await c.save();
    },
    skip: 2,
    expect: () => <AvailabilityPromptState>[
      const AvailabilityPromptState(
        selected: 'within_month',
        failure: InvalidRequestFailure('availability.status is not allowed'),
      ),
    ],
  );

  blocTest<AvailabilityPromptCubit, AvailabilityPromptState>(
    'an unexpected error still lands as a failure, never a stuck spinner',
    build: () {
      when(() => repo.saveWorkPreferences(any())).thenThrow(StateError('boom'));
      return build();
    },
    act: (AvailabilityPromptCubit c) async {
      c.select('within_month');
      await c.save();
    },
    skip: 2,
    expect: () => <AvailabilityPromptState>[
      const AvailabilityPromptState(
        selected: 'within_month',
        failure: UnknownFailure(),
      ),
    ],
  );

  blocTest<AvailabilityPromptCubit, AvailabilityPromptState>(
    'a new pick after a failure clears the reason',
    build: build,
    seed: () => const AvailabilityPromptState(
      selected: 'immediate',
      failure: NetworkFailure(),
    ),
    act: (AvailabilityPromptCubit c) => c.select('within_week'),
    expect: () => <AvailabilityPromptState>[
      const AvailabilityPromptState(selected: 'within_week'),
    ],
  );

  blocTest<AvailabilityPromptCubit, AvailabilityPromptState>(
    'nothing changes while a save is in flight',
    build: build,
    seed: () => const AvailabilityPromptState(
      status: AvailabilityPromptStatus.saving,
      selected: 'immediate',
    ),
    act: (AvailabilityPromptCubit c) async {
      c.select('within_week');
      await c.save();
    },
    expect: () => <AvailabilityPromptState>[],
    verify: (_) => verifyNever(() => repo.saveWorkPreferences(any())),
  );
}
