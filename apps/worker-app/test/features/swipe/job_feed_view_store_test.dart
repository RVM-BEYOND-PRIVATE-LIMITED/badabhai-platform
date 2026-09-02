import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:badabhai_worker_app/features/swipe/data/job_feed_view_store.dart';

void main() {
  group('SessionOnlyJobFeedViewStore', () {
    test('always reads list, even after a write', () async {
      const SessionOnlyJobFeedViewStore store = SessionOnlyJobFeedViewStore();
      expect(await store.read(), JobFeedViewMode.list);

      await store.write(JobFeedViewMode.deck);
      // write() is a no-op — nothing persists.
      expect(await store.read(), JobFeedViewMode.list);
    });
  });

  group('SharedPrefsJobFeedViewStore', () {
    setUp(() => SharedPreferences.setMockInitialValues(<String, Object>{}));

    test('defaults to list when unset', () async {
      const SharedPrefsJobFeedViewStore store = SharedPrefsJobFeedViewStore();
      expect(await store.read(), JobFeedViewMode.list);
    });

    test('round-trips a written value through a real prefs instance',
        () async {
      const SharedPrefsJobFeedViewStore store = SharedPrefsJobFeedViewStore();
      await store.write(JobFeedViewMode.deck);

      // Survives a "cold start" — a fresh store instance over the same prefs.
      const SharedPrefsJobFeedViewStore reborn = SharedPrefsJobFeedViewStore();
      expect(await reborn.read(), JobFeedViewMode.deck);

      await reborn.write(JobFeedViewMode.list);
      expect(await store.read(), JobFeedViewMode.list);
    });

    test('the persisted key is bb_-prefixed and stores only the mode name',
        () async {
      const SharedPrefsJobFeedViewStore store = SharedPrefsJobFeedViewStore();
      await store.write(JobFeedViewMode.deck);

      final SharedPreferences prefs = await SharedPreferences.getInstance();
      expect(SharedPrefsJobFeedViewStore.kViewMode, 'bb_job_feed_view_mode');
      expect(prefs.getString(SharedPrefsJobFeedViewStore.kViewMode), 'deck');
    });
  });
}
