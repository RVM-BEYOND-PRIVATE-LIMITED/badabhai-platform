import 'dart:async';

import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/features/match_skills/domain/match_skill.dart';
import 'package:badabhai_worker_app/features/match_skills/domain/match_skills_repository.dart';
import 'package:badabhai_worker_app/features/match_skills/presentation/cubit/match_skills_cubit.dart';
import 'package:bloc_test/bloc_test.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

class _MockRepo extends Mock implements MatchSkillsRepository {}

const MatchSkill _cnc =
    MatchSkill(skillId: 'mskill_cnc_turner', label: 'CNC Turner', wants: true);
const MatchSkill _vmc = MatchSkill(
  skillId: 'mskill_vmc_operator',
  label: 'VMC Operator',
  wants: false,
);
const MatchSkill _fitter =
    MatchSkill(skillId: 'mskill_fitter', label: 'Fitter', wants: true);

const MatchSkillsState _ready = MatchSkillsState(
  status: MatchSkillsStatus.ready,
  skills: <MatchSkill>[_cnc, _vmc],
);

void main() {
  late _MockRepo repo;

  setUp(() => repo = _MockRepo());

  blocTest<MatchSkillsCubit, MatchSkillsState>(
    'load renders the server list, OFF rows included',
    build: () {
      when(() => repo.list())
          .thenAnswer((_) async => const <MatchSkill>[_cnc, _vmc]);
      return MatchSkillsCubit(repo);
    },
    act: (MatchSkillsCubit c) => c.load(),
    expect: () => const <MatchSkillsState>[MatchSkillsState(), _ready],
  );

  blocTest<MatchSkillsCubit, MatchSkillsState>(
    'a failed load carries the real failure',
    build: () {
      when(() => repo.list()).thenThrow(const NetworkFailure());
      return MatchSkillsCubit(repo);
    },
    act: (MatchSkillsCubit c) => c.load(),
    expect: () => const <MatchSkillsState>[
      MatchSkillsState(),
      MatchSkillsState(
        status: MatchSkillsStatus.failed,
        failure: NetworkFailure(),
      ),
    ],
  );

  blocTest<MatchSkillsCubit, MatchSkillsState>(
    'setWants renders what the SERVER holds, not the tap',
    build: () {
      // The worker asked for OFF; the server answers ON — the switch follows
      // the server.
      when(() => repo.setWants('mskill_cnc_turner', wants: false))
          .thenAnswer((_) async => true);
      return MatchSkillsCubit(repo);
    },
    seed: () => _ready,
    act: (MatchSkillsCubit c) => c.setWants('mskill_cnc_turner', wants: false),
    expect: () => const <MatchSkillsState>[
      MatchSkillsState(
        status: MatchSkillsStatus.ready,
        skills: <MatchSkill>[_cnc, _vmc],
        savingId: 'mskill_cnc_turner',
      ),
      _ready,
    ],
  );

  blocTest<MatchSkillsCubit, MatchSkillsState>(
    'turning a skill OFF keeps its row in the list',
    build: () {
      when(() => repo.setWants('mskill_cnc_turner', wants: false))
          .thenAnswer((_) async => false);
      return MatchSkillsCubit(repo);
    },
    seed: () => _ready,
    act: (MatchSkillsCubit c) => c.setWants('mskill_cnc_turner', wants: false),
    skip: 1,
    expect: () => <MatchSkillsState>[
      MatchSkillsState(
        status: MatchSkillsStatus.ready,
        skills: <MatchSkill>[_cnc.withWants(false), _vmc],
      ),
    ],
  );

  blocTest<MatchSkillsCubit, MatchSkillsState>(
    'turning an OFF skill back ON sends wants: true',
    build: () {
      when(() => repo.setWants('mskill_vmc_operator', wants: true))
          .thenAnswer((_) async => true);
      return MatchSkillsCubit(repo);
    },
    seed: () => _ready,
    act: (MatchSkillsCubit c) => c.setWants('mskill_vmc_operator', wants: true),
    skip: 1,
    expect: () => <MatchSkillsState>[
      MatchSkillsState(
        status: MatchSkillsStatus.ready,
        skills: <MatchSkill>[_cnc, _vmc.withWants(true)],
      ),
    ],
  );

  blocTest<MatchSkillsCubit, MatchSkillsState>(
    'a failed write surfaces the failure, then renders the re-read list',
    build: () {
      when(() => repo.setWants('mskill_cnc_turner', wants: false))
          .thenThrow(const ServerFailure(404));
      // Differs from the seed, so the test fails if the re-read is dropped.
      when(() => repo.list())
          .thenAnswer((_) async => const <MatchSkill>[_vmc]);
      return MatchSkillsCubit(repo);
    },
    seed: () => _ready,
    act: (MatchSkillsCubit c) => c.setWants('mskill_cnc_turner', wants: false),
    skip: 1,
    expect: () => const <MatchSkillsState>[
      MatchSkillsState(
        status: MatchSkillsStatus.ready,
        skills: <MatchSkill>[_cnc, _vmc],
        refreshing: true,
        writeFailure: ServerFailure(404),
        writeSeq: 1,
      ),
      MatchSkillsState(
        status: MatchSkillsStatus.ready,
        skills: <MatchSkill>[_vmc],
        writeFailure: ServerFailure(404),
        writeSeq: 1,
      ),
    ],
    verify: (_) => verify(() => repo.list()).called(1),
  );

  test('every switch stays locked until the re-read after a failed write lands',
      () async {
    // Unlocked, a second write could succeed while this older read is in
    // flight, and the read would then paint the second row back.
    final Completer<List<MatchSkill>> reread = Completer<List<MatchSkill>>();
    when(() => repo.setWants('mskill_cnc_turner', wants: false))
        .thenThrow(const NetworkFailure());
    when(() => repo.list())
        .thenAnswer((_) async => const <MatchSkill>[_cnc, _vmc]);
    final MatchSkillsCubit cubit = MatchSkillsCubit(repo);
    await cubit.load();
    expect(cubit.state, _ready);
    when(() => repo.list()).thenAnswer((_) => reread.future);

    final Future<void> failing =
        cubit.setWants('mskill_cnc_turner', wants: false);
    await Future<void>.delayed(Duration.zero);
    expect(cubit.state.refreshing, isTrue);
    expect(cubit.state.busy, isTrue);

    await cubit.setWants('mskill_vmc_operator', wants: true);
    await cubit.clearAll();
    verifyNever(() => repo.setWants('mskill_vmc_operator', wants: true));
    verifyNever(() => repo.clearAll());

    reread.complete(const <MatchSkill>[_cnc, _vmc]);
    await failing;
    expect(cubit.state.refreshing, isFalse);
    expect(cubit.state.busy, isFalse);
    await cubit.close();
  });

  blocTest<MatchSkillsCubit, MatchSkillsState>(
    'a failed re-read after a failed write keeps the rows and unlocks',
    build: () {
      when(() => repo.setWants('mskill_cnc_turner', wants: false))
          .thenThrow(const NetworkFailure());
      when(() => repo.list()).thenThrow(const NetworkFailure());
      return MatchSkillsCubit(repo);
    },
    seed: () => _ready,
    act: (MatchSkillsCubit c) => c.setWants('mskill_cnc_turner', wants: false),
    skip: 2,
    expect: () => const <MatchSkillsState>[
      MatchSkillsState(
        status: MatchSkillsStatus.ready,
        skills: <MatchSkill>[_cnc, _vmc],
        writeFailure: NetworkFailure(),
        writeSeq: 1,
      ),
    ],
  );

  blocTest<MatchSkillsCubit, MatchSkillsState>(
    'a second tap while a write is in flight is ignored',
    build: () {
      when(() => repo.setWants(any(), wants: any(named: 'wants')))
          .thenAnswer((_) async => false);
      return MatchSkillsCubit(repo);
    },
    seed: () => _ready.copyWith(savingId: () => 'mskill_cnc_turner'),
    act: (MatchSkillsCubit c) => c.setWants('mskill_vmc_operator', wants: true),
    expect: () => const <MatchSkillsState>[],
    verify: (_) =>
        verifyNever(() => repo.setWants(any(), wants: any(named: 'wants'))),
  );

  blocTest<MatchSkillsCubit, MatchSkillsState>(
    'clearAll re-reads the list and counts only the switches it turned off',
    build: () {
      when(() => repo.clearAll()).thenAnswer((_) async {});
      // Two were on, one was already off. The re-read also drops a row, so
      // the test fails if the cubit skips it and uses its local fallback.
      when(() => repo.list()).thenAnswer(
        (_) async => <MatchSkill>[_cnc.withWants(false), _vmc],
      );
      return MatchSkillsCubit(repo);
    },
    seed: () => const MatchSkillsState(
      status: MatchSkillsStatus.ready,
      skills: <MatchSkill>[_cnc, _vmc, _fitter],
    ),
    act: (MatchSkillsCubit c) => c.clearAll(),
    expect: () => <MatchSkillsState>[
      const MatchSkillsState(
        status: MatchSkillsStatus.ready,
        skills: <MatchSkill>[_cnc, _vmc, _fitter],
        clearing: true,
      ),
      MatchSkillsState(
        status: MatchSkillsStatus.ready,
        skills: <MatchSkill>[_cnc.withWants(false), _vmc],
        // CNC Turner only: VMC Operator was already off, and Fitter is no
        // longer in the list the server returned.
        turnedOff: 1,
        clearSeq: 1,
      ),
    ],
    verify: (_) => verify(() => repo.list()).called(1),
  );

  blocTest<MatchSkillsCubit, MatchSkillsState>(
    'clearAll whose re-read fails still shows every row off (server confirmed)',
    build: () {
      when(() => repo.clearAll()).thenAnswer((_) async {});
      when(() => repo.list()).thenThrow(const NetworkFailure());
      return MatchSkillsCubit(repo);
    },
    seed: () => const MatchSkillsState(
      status: MatchSkillsStatus.ready,
      skills: <MatchSkill>[_cnc, _vmc, _fitter],
    ),
    act: (MatchSkillsCubit c) => c.clearAll(),
    skip: 1,
    expect: () => <MatchSkillsState>[
      MatchSkillsState(
        status: MatchSkillsStatus.ready,
        skills: <MatchSkill>[
          _cnc.withWants(false),
          _vmc,
          _fitter.withWants(false),
        ],
        turnedOff: 2,
        clearSeq: 1,
      ),
    ],
  );

  blocTest<MatchSkillsCubit, MatchSkillsState>(
    'a failed clearAll surfaces the failure, then renders the re-read list',
    build: () {
      when(() => repo.clearAll()).thenThrow(const NetworkFailure());
      // Differs from the seed, so the test fails if the re-read is dropped.
      when(() => repo.list())
          .thenAnswer((_) async => <MatchSkill>[_cnc.withWants(false), _vmc]);
      return MatchSkillsCubit(repo);
    },
    seed: () => _ready,
    act: (MatchSkillsCubit c) => c.clearAll(),
    skip: 1,
    expect: () => <MatchSkillsState>[
      const MatchSkillsState(
        status: MatchSkillsStatus.ready,
        skills: <MatchSkill>[_cnc, _vmc],
        refreshing: true,
        writeFailure: NetworkFailure(),
        writeSeq: 1,
      ),
      MatchSkillsState(
        status: MatchSkillsStatus.ready,
        skills: <MatchSkill>[_cnc.withWants(false), _vmc],
        writeFailure: const NetworkFailure(),
        writeSeq: 1,
      ),
    ],
    verify: (_) => verify(() => repo.list()).called(1),
  );
}
