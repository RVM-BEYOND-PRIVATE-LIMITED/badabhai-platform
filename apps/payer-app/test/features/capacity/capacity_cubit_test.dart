import 'package:flutter_test/flutter_test.dart';

import 'package:payer_app/core/data/mock_payer_api_client.dart';
import 'package:payer_app/core/data/models.dart';
import 'package:payer_app/features/capacity/presentation/cubit/capacity_cubit.dart';

/// #366 — CapacityCubit is a one-method read, but the thing it must never do is
/// exactly the thing a careless refactor does: turn a failed read into a
/// fabricated all-zero allowance. A zero allowance renders as "you are at
/// capacity, you cannot post" — a hard stop invented out of an outage.
class _ScriptedCapacityApi extends MockPayerApiClient {
  CapacityView capacity = const CapacityView(
    maxActiveVacancies: 5,
    activePlanCount: 3,
    sourceTier: 'cap_5',
  );

  Object? throwOnFetch;
  int fetches = 0;

  @override
  Future<CapacityView> fetchCapacity() async {
    fetches++;
    if (throwOnFetch != null) throw throwOnFetch!;
    return capacity;
  }
}

void main() {
  late _ScriptedCapacityApi api;
  late CapacityCubit cubit;

  setUp(() {
    api = _ScriptedCapacityApi();
    cubit = CapacityCubit(api);
  });

  tearDown(() => cubit.close());

  test('initial state is unknown — no allowance is assumed', () {
    expect(cubit.state.status, CapacityStatus.initial);
    expect(cubit.state.capacity, isNull);
    expect(cubit.state.error, isNull);
  });

  test('load emits the server allowance verbatim', () async {
    await cubit.load();

    expect(cubit.state.status, CapacityStatus.ready);
    expect(cubit.state.capacity?.maxActiveVacancies, 5);
    expect(cubit.state.capacity?.activePlanCount, 3);
    expect(cubit.state.capacity?.remaining, 2);
    expect(cubit.state.capacity?.atCapacity, isFalse);
    expect(cubit.state.error, isNull);
    expect(api.fetches, 1);
  });

  test('a full allowance reports atCapacity with zero headroom', () async {
    api.capacity = const CapacityView(
      maxActiveVacancies: 2,
      activePlanCount: 2,
      sourceTier: 'cap_2',
    );

    await cubit.load();

    expect(cubit.state.capacity?.remaining, 0);
    expect(cubit.state.capacity?.atCapacity, isTrue);
  });

  test('a failed read is an honest error — NEVER a fabricated zero allowance',
      () async {
    api.throwOnFetch = const PayerApiException(503);

    await cubit.load();

    expect(cubit.state.status, CapacityStatus.error);
    expect(cubit.state.error, isNotNull);
    expect(cubit.state.capacity, isNull,
        reason: 'a zero allowance would render as a hard "at capacity" stop '
            'invented from an outage');
  });

  test('an error after a good read keeps the last-known allowance', () async {
    await cubit.load();
    final CapacityView known = cubit.state.capacity!;

    api.throwOnFetch = const PayerApiException(500);
    await cubit.load();

    expect(cubit.state.status, CapacityStatus.error);
    expect(cubit.state.capacity, known,
        reason: 'the last-known numbers stay, flagged by the error state — '
            'they are never replaced with zeros');
  });

  test('a later successful read clears the error', () async {
    api.throwOnFetch = const PayerApiException(500);
    await cubit.load();
    expect(cubit.state.error, isNotNull);

    api.throwOnFetch = null;
    await cubit.load();

    expect(cubit.state.status, CapacityStatus.ready);
    expect(cubit.state.error, isNull);
  });
}
