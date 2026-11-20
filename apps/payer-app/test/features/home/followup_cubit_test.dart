import 'package:flutter_test/flutter_test.dart';

import 'package:payer_app/core/data/mock_payer_api_client.dart';
import 'package:payer_app/core/data/models.dart';
import 'package:payer_app/core/data/unlock_followup_models.dart';
import 'package:payer_app/features/home/presentation/cubit/followup_cubit.dart';

const List<UnlockFollowupItem> _seed = <UnlockFollowupItem>[
  UnlockFollowupItem(
    unlockId: 'u-1',
    workerId: 'w-1',
    grantedAt: '2026-11-01T10:00:00Z',
  ),
  UnlockFollowupItem(
    unlockId: 'u-2',
    workerId: 'w-2',
    grantedAt: '2026-11-02T10:00:00Z',
    outcome: UnlockFollowupOutcome.stillTalking,
  ),
];

class _RecordedCall {
  const _RecordedCall(this.unlockId, this.outcome, this.key);
  final String unlockId;
  final UnlockFollowupOutcome outcome;
  final String key;
}

class _ScriptedFollowupApi extends MockPayerApiClient {
  List<UnlockFollowupItem> items = List<UnlockFollowupItem>.of(_seed);
  Object? throwOnFetch;
  Object? throwOnRecord;
  final List<_RecordedCall> calls = <_RecordedCall>[];

  @override
  Future<UnlockFollowupPage?> fetchDueUnlockOutcomes({
    int limit = 20,
    String? cursor,
  }) async {
    if (throwOnFetch != null) throw throwOnFetch!;
    return UnlockFollowupPage(
      items: List<UnlockFollowupItem>.unmodifiable(items),
      nextCursor: null,
    );
  }

  @override
  Future<UnlockFollowupResult> recordUnlockOutcome({
    required String unlockId,
    required UnlockFollowupOutcome outcome,
    required String idempotencyKey,
  }) async {
    calls.add(_RecordedCall(unlockId, outcome, idempotencyKey));
    if (throwOnRecord != null) throw throwOnRecord!;
    final int index =
        items.indexWhere((UnlockFollowupItem r) => r.unlockId == unlockId);
    if (index < 0) throw const PayerApiException(404);
    final UnlockFollowupItem row = items.removeAt(index);
    return UnlockFollowupResult(
      unlockId: row.unlockId,
      workerId: row.workerId,
      outcome: outcome,
      previousOutcome: UnlockStoredOutcome.fromCompany(row.outcome),
      answeredAt: '2026-11-20T10:00:00Z',
      changed: true,
    );
  }
}

void main() {
  late _ScriptedFollowupApi api;
  late FollowupCubit cubit;
  int minted = 0;

  setUp(() {
    api = _ScriptedFollowupApi();
    minted = 0;
    cubit = FollowupCubit(api, mintKey: () => 'key-${++minted}');
  });

  tearDown(() => cubit.close());

  test('initial state is hidden and unknown', () {
    expect(cubit.state.status, FollowupStatus.initial);
    expect(cubit.state.items, isEmpty);
    expect(cubit.state.visible, isFalse);
  });

  test('load reads the due page and shows its rows', () async {
    await cubit.load();

    expect(cubit.state.status, FollowupStatus.ready);
    expect(cubit.state.visible, isTrue);
    expect(cubit.state.items, hasLength(2));
    expect(cubit.state.items.first.unlockId, 'u-1');
  });

  test('a 404 means the switch is off: hidden, not an error', () async {
    api.throwOnFetch = const PayerApiException(404);

    await cubit.load();

    expect(cubit.state.status, FollowupStatus.off);
    expect(cubit.state.visible, isFalse);
    expect(cubit.state.items, isEmpty);
  });

  test('a read failure is an error, NEVER an empty success', () async {
    api.throwOnFetch = const PayerApiException(503);

    await cubit.load();

    expect(cubit.state.status, FollowupStatus.error);
    expect(cubit.state.visible, isFalse);
    expect(cubit.state.items, isEmpty);
  });

  test('an answered row is removed with one idempotency key for the intent',
      () async {
    await cubit.load();
    final UnlockFollowupItem item = cubit.state.items.first;

    final FollowupAnswerResult result =
        await cubit.answer(item, UnlockFollowupOutcome.hired);

    expect(result, FollowupAnswerResult.saved);
    expect(cubit.state.items.map((UnlockFollowupItem i) => i.unlockId),
        isNot(contains(item.unlockId)));
    expect(cubit.state.items, hasLength(1));
    expect(api.calls.single.unlockId, item.unlockId);
    expect(api.calls.single.outcome, UnlockFollowupOutcome.hired);
    expect(api.calls.single.key, isNotEmpty);
  });

  test('a failed answer keeps the row and retries the SAME key', () async {
    await cubit.load();
    final UnlockFollowupItem item = cubit.state.items.first;
    api.throwOnRecord = const PayerApiException(500);

    final FollowupAnswerResult first =
        await cubit.answer(item, UnlockFollowupOutcome.notHired);
    expect(first, FollowupAnswerResult.failed);
    expect(cubit.state.items, hasLength(2));
    expect(cubit.state.answerError, 'failed');

    api.throwOnRecord = null;
    final FollowupAnswerResult second =
        await cubit.answer(item, UnlockFollowupOutcome.notHired);

    expect(second, FollowupAnswerResult.saved);
    expect(cubit.state.items, hasLength(1));
    expect(api.calls, hasLength(2));
    expect(api.calls[1].key, api.calls[0].key,
        reason: 'the retry replays the same intent, never records again');
  });

  test('a neutral 404 answer drops the stale row without an error', () async {
    await cubit.load();
    final UnlockFollowupItem item = cubit.state.items.first;
    api.throwOnRecord = const PayerApiException(404);

    final FollowupAnswerResult result =
        await cubit.answer(item, UnlockFollowupOutcome.hired);

    expect(result, FollowupAnswerResult.notFound);
    expect(cubit.state.items, hasLength(1));
    expect(cubit.state.answerError, isNull);
  });
}
