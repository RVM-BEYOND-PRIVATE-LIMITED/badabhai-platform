import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/session/session_repository.dart';
import 'package:badabhai_worker_app/features/extracted_review/data/extracted_review_repository_impl.dart';

class MockApiClient extends Mock implements ApiClient {}

const List<CatalogueOptionDto> _skills = <CatalogueOptionDto>[
  CatalogueOptionDto(id: 'skill_fanuc', label: 'Fanuc control operation'),
];

const List<CatalogueOptionDto> _machines = <CatalogueOptionDto>[
  CatalogueOptionDto(id: 'mach_vmc', label: 'Vertical Machining Center (VMC)'),
];

/// #1596 — the catalogue reads go out with the worker's bearer and every
/// miss arrives as a TYPED [Failure], so the card can name the real reason.
void main() {
  late MockApiClient api;
  late ExtractedReviewRepositoryImpl repo;

  setUp(() {
    api = MockApiClient();
    repo = ExtractedReviewRepositoryImpl(
      api,
      SessionRepository()
        ..setWorker(
            phone: '+910000000000', workerId: 'w1', sessionToken: 'tok'),
    );
  });

  test('skill + machine catalogues pass through with the session bearer',
      () async {
    when(() => api.getSkillOptions(authToken: any(named: 'authToken')))
        .thenAnswer((_) async => _skills);
    when(() => api.getMachineOptions(authToken: any(named: 'authToken')))
        .thenAnswer((_) async => _machines);

    expect(await repo.loadSkillOptions(), _skills);
    expect(await repo.loadMachineOptions(), _machines);
    verify(() => api.getSkillOptions(authToken: 'tok')).called(1);
    verify(() => api.getMachineOptions(authToken: 'tok')).called(1);
  });

  test('a 403 consent gate maps to ConsentRequiredFailure', () async {
    when(() => api.getSkillOptions(authToken: any(named: 'authToken')))
        .thenThrow(ApiException(403, 'consent required'));
    await expectLater(
      repo.loadSkillOptions(),
      throwsA(isA<ConsentRequiredFailure>()),
    );
  });

  test('an unreachable server maps to NetworkFailure', () async {
    when(() => api.getMachineOptions(authToken: any(named: 'authToken')))
        .thenThrow(const SocketException('down'));
    await expectLater(
      repo.loadMachineOptions(),
      throwsA(isA<NetworkFailure>()),
    );
  });
}
