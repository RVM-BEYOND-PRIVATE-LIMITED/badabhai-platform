import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:badabhai_worker_app/features/availability_prompt/data/availability_prompt_store.dart';
import 'package:badabhai_worker_app/features/availability_prompt/domain/availability_prompt_store.dart';

/// #2748 item 1d — "not now" on the availability prompt, remembered on the
/// device per worker so the worker is asked once. Persisted, so a cold start
/// does not ask again; best-effort, so it never throws.
void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues(<String, Object>{});
  });

  const SharedPrefsAvailabilityPromptStore store =
      SharedPrefsAvailabilityPromptStore();

  test('nothing dismissed yet reads as not dismissed', () async {
    expect(await store.isDismissed(workerId: 'w1'), isFalse);
  });

  test('a dismissal is persisted under the worker\'s own key', () async {
    await store.markDismissed(workerId: 'w1');

    expect(await store.isDismissed(workerId: 'w1'), isTrue);
    final SharedPreferences prefs = await SharedPreferences.getInstance();
    expect(prefs.getBool('bb_availability_prompt_dismissed_w1'), isTrue);
  });

  test(
    'it is per worker: the next worker on the phone is not dismissed',
    () async {
      await store.markDismissed(workerId: 'w1');

      expect(await store.isDismissed(workerId: 'w2'), isFalse);
    },
  );

  test(
    'a failing platform store reads as not dismissed and swallows writes',
    () async {
      final SharedPrefsAvailabilityPromptStore broken =
          SharedPrefsAvailabilityPromptStore(
            prefs: () =>
                Future<SharedPreferences>.error(StateError('no plugin')),
          );

      expect(await broken.isDismissed(workerId: 'w1'), isFalse);
      await broken.markDismissed(workerId: 'w1');
    },
  );

  test('the in-memory store keeps the same contract', () async {
    final AvailabilityPromptStore memory = InMemoryAvailabilityPromptStore();

    expect(await memory.isDismissed(workerId: 'w1'), isFalse);
    await memory.markDismissed(workerId: 'w1');
    expect(await memory.isDismissed(workerId: 'w1'), isTrue);
    expect(await memory.isDismissed(workerId: 'w2'), isFalse);
  });
}
