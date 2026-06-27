import 'package:bloc_test/bloc_test.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/features/kit/domain/interview_kit.dart';
import 'package:badabhai_worker_app/features/kit/domain/interview_kit_repository.dart';
import 'package:badabhai_worker_app/features/kit/presentation/cubit/kit_detail_cubit.dart';

class MockInterviewKitRepository extends Mock
    implements InterviewKitRepository {}

const InterviewKit _kit = InterviewKit(
  tradeKey: 'cnc_operator',
  title: 'CNC Operator',
  qas: <KitQa>[
    KitQa(
      question: 'Tool offset kaise set karte hain?',
      answer: 'Tool ko reference par le jaakar offset daalte hain.',
    ),
  ],
);

void main() {
  late MockInterviewKitRepository repo;
  setUp(() => repo = MockInterviewKitRepository());

  // bloc emits the first state even when it equals the initial `loading`.
  blocTest<KitDetailCubit, KitDetailState>(
    'load success -> loading then ready with the kit',
    build: () {
      when(() => repo.kit(any())).thenAnswer((_) async => _kit);
      return KitDetailCubit(repo);
    },
    act: (KitDetailCubit c) => c.load('cnc_operator'),
    expect: () => const <KitDetailState>[
      KitDetailState(status: KitDetailStatus.loading),
      KitDetailState(status: KitDetailStatus.ready, kit: _kit),
    ],
    verify: (_) => verify(() => repo.kit('cnc_operator')).called(1),
  );

  blocTest<KitDetailCubit, KitDetailState>(
    'load failure -> failed (not a stuck spinner)',
    build: () {
      when(() => repo.kit(any())).thenThrow(const NetworkFailure());
      return KitDetailCubit(repo);
    },
    act: (KitDetailCubit c) => c.load('cnc_operator'),
    expect: () => const <KitDetailState>[
      KitDetailState(status: KitDetailStatus.loading),
      KitDetailState(status: KitDetailStatus.failed),
    ],
  );
}
