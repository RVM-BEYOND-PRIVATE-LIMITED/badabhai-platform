import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:badabhai_worker_app/core/session/resume_download_offer_store.dart';

/// Owner ruling (2026-10-15) — which résumé version the Bada Bhai chat's
/// "Resume download" tile was last offered for. Persisted, so a cold start does
/// not offer the same résumé again; best-effort, so it never throws.
void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues(<String, Object>{});
  });

  const SharedPrefsResumeDownloadOfferStore store =
      SharedPrefsResumeDownloadOfferStore();

  test('nothing offered yet reads as null', () async {
    expect(await store.lastOffered(), isNull);
  });

  test('a marked version round-trips, and the latest mark wins', () async {
    await store.markOffered('r1@2026-10-14T09:00:00.000Z');
    expect(await store.lastOffered(), 'r1@2026-10-14T09:00:00.000Z');

    await store.markOffered('r1@2026-10-15T08:00:00.000Z');
    expect(await store.lastOffered(), 'r1@2026-10-15T08:00:00.000Z');
  });

  test('an empty version is never recorded', () async {
    await store.markOffered('r1@x');
    await store.markOffered('');
    expect(await store.lastOffered(), 'r1@x');
  });

  test('clear (logout) forgets it, so the next worker is offered their own', () async {
    await store.markOffered('r1@x');
    await store.clear();
    expect(await store.lastOffered(), isNull);
  });

  test('a failing platform store reads as null and swallows writes', () async {
    final SharedPrefsResumeDownloadOfferStore broken =
        SharedPrefsResumeDownloadOfferStore(
          prefs: () => Future<SharedPreferences>.error(StateError('no plugin')),
        );
    expect(await broken.lastOffered(), isNull);
    await broken.markOffered('r1@x');
    await broken.clear();
  });

  test('the in-memory store keeps the same contract', () async {
    final InMemoryResumeDownloadOfferStore memory =
        InMemoryResumeDownloadOfferStore();
    expect(await memory.lastOffered(), isNull);
    await memory.markOffered('r1@x');
    expect(await memory.lastOffered(), 'r1@x');
    await memory.markOffered('');
    expect(await memory.lastOffered(), 'r1@x');
    await memory.clear();
    expect(await memory.lastOffered(), isNull);
  });
}
