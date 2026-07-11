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
  overview: 'Machine, drawing aur safety ki samajh check hoti hai.',
  commonQuestions: <String>['Tool offset kaise set karte hain?'],
  practicalQuestions: <String>['Saved program se job kaise start karte hain?'],
  safetyQuestions: <String>['Kaun sa PPE pehnte hain?'],
  drawingMeasurementQuestions: <String>['Tolerance kaise padhte hain?'],
  skillChecklist: <String>['Fanuc control'],
  reviseBefore: <String>['Basic G/M codes'],
  documentsToCarry: <String>['Aadhaar card'],
  commonMistakes: <String>['First piece inspection skip karna'],
  hinglishNote: 'Aaram se saaf jawaab dein.',
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
      KitDetailState(status: KitDetailStatus.failed, failure: NetworkFailure()),
    ],
  );

  test('resolveDownloadUrl returns the signed url on success', () async {
    when(() => repo.downloadUrl(any()))
        .thenAnswer((_) async => 'https://signed/k?token=x');
    final KitDetailCubit cubit = KitDetailCubit(repo);
    expect(await cubit.resolveDownloadUrl('cnc_operator'),
        'https://signed/k?token=x');
    verify(() => repo.downloadUrl('cnc_operator')).called(1);
  });

  test('resolveDownloadUrl PROPAGATES the Failure (so the launcher shows the '
      'real reason, not a blank generic line)', () {
    when(() => repo.downloadUrl(any())).thenThrow(const NetworkFailure());
    final KitDetailCubit cubit = KitDetailCubit(repo);
    expect(() => cubit.resolveDownloadUrl('cnc_operator'),
        throwsA(isA<NetworkFailure>()));
  });
}
