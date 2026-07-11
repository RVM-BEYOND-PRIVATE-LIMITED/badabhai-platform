import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/features/kit/data/interview_kit_repository_impl.dart';
import 'package:badabhai_worker_app/features/kit/domain/interview_kit.dart';

class MockApiClient extends Mock implements ApiClient {}

void main() {
  late MockApiClient api;
  setUp(() => api = MockApiClient());

  test('listKits maps the live list (trade_key → tradeKey, real subtitle)',
      () async {
    when(() => api.getInterviewKits())
        .thenAnswer((_) async => const <InterviewKitListItem>[
              InterviewKitListItem(
                  tradeKey: 'cnc_operator', displayName: 'CNC Operator'),
              InterviewKitListItem(tradeKey: 'fitter', displayName: 'Fitter'),
            ]);

    final List<KitListItem> items =
        await InterviewKitRepositoryImpl(api).listKits();

    expect(items, hasLength(2));
    expect(items.first.tradeKey, 'cnc_operator');
    expect(items.first.title, 'CNC Operator');
    expect(items.first.subtitle, isNotEmpty);
    expect(items[1].tradeKey, 'fitter');
  });

  test('listKits returns [] when the live list is empty (→ real empty state)',
      () async {
    when(() => api.getInterviewKits())
        .thenAnswer((_) async => const <InterviewKitListItem>[]);
    expect(await InterviewKitRepositoryImpl(api).listKits(), isEmpty);
  });

  test('kit maps the prep-pack (question LISTS + checklist + docs, no answers)',
      () async {
    when(() => api.getInterviewKit(any()))
        .thenAnswer((_) async => const InterviewKitContentDto(
              tradeKey: 'cnc_operator',
              displayName: 'CNC Operator',
              overview: 'ov',
              commonQuestions: <String>['q1'],
              practicalQuestions: <String>['q2'],
              safetyQuestions: <String>['q3'],
              drawingMeasurementQuestions: <String>['q4'],
              skillChecklist: <String>['s1'],
              reviseBefore: <String>['r1'],
              documentsToCarry: <String>['d1'],
              commonMistakes: <String>['m1'],
              hinglishNote: 'note',
            ));

    final InterviewKit kit =
        await InterviewKitRepositoryImpl(api).kit('cnc_operator');

    expect(kit.tradeKey, 'cnc_operator');
    expect(kit.title, 'CNC Operator');
    expect(kit.overview, 'ov');
    expect(kit.commonQuestions, <String>['q1']);
    expect(kit.documentsToCarry, <String>['d1']);
    expect(kit.hinglishNote, 'note');
    verify(() => api.getInterviewKit('cnc_operator')).called(1);
  });

  test('kit maps a 404 (unknown trade) to a typed Failure (real reason)', () {
    when(() => api.getInterviewKit(any()))
        .thenThrow(ApiException(404, 'not found'));
    expect(() => InterviewKitRepositoryImpl(api).kit('nope'),
        throwsA(isA<Failure>()));
  });

  test('listKits maps a 429 to RateLimitedFailure', () {
    when(() => api.getInterviewKits())
        .thenThrow(ApiException(429, 'slow down'));
    expect(() => InterviewKitRepositoryImpl(api).listKits(),
        throwsA(isA<RateLimitedFailure>()));
  });

  test('downloadUrl still returns the signed url from the download route',
      () async {
    when(() => api.downloadInterviewKit(any())).thenAnswer((_) async =>
        const InterviewKitDownload(
            url: 'https://signed/k?token=x', expiresInSeconds: 900));
    expect(await InterviewKitRepositoryImpl(api).downloadUrl('cnc_operator'),
        'https://signed/k?token=x');
  });
}
