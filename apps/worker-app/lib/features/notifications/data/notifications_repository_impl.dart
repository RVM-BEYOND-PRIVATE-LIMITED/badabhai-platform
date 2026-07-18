import 'package:flutter/foundation.dart';

import '../../../core/api/api_client.dart';
import '../../../core/error/failure.dart';
import '../../../core/error/failure_mapper.dart';
import '../../../core/session/session_repository.dart';
import '../domain/app_notification.dart';
import '../domain/notifications_repository.dart';
import 'notification_read_store.dart';

/// Real worker-scoped Alerts feed (follows the applications/resume real-repo
/// pattern: ctor takes [ApiClient] + [SessionRepository]).
///
/// Reads GET /workers/me/notifications — a FACELESS, PII-FREE projection of the
/// worker's own real events (copy is server-rendered; no employer/pay/name/phone)
/// — and maps the rows into [AppNotification]s for the UI, unchanged.
///
/// READ-STATE is CLIENT-DURABLE (#456 / TD90). The `events` spine is append-only
/// and there is still no server read-state store, so read-state remains a client
/// concern — but it is no longer SESSION-LOCAL. It used to live in a plain
/// in-memory Set, which meant a worker who read "Naye device se login" and then
/// force-quit saw that same account-takeover alert come back UNREAD on every
/// cold start. That teaches a worker to swipe past exactly the alerts that
/// matter most, so the ids now persist through a [NotificationReadStore].
///
/// This is the honest INTERIM the tech-debt register calls for, not the fix:
/// durable read state on the SERVER is a schema change (a per-worker read cursor
/// / read-receipts table) plus DPDP review, and is tracked separately. The
/// consequence of client-only state is that read-state does not follow the
/// worker to a new device or survive an app-data clear — a reset badge, never a
/// lost alert.
///
/// Registered as a lazySingleton so the Alerts screen and the shell badge share
/// one instance (and the same read-state).
class NotificationsRepositoryImpl implements NotificationsRepository {
  NotificationsRepositoryImpl(
    this._api,
    this._session, {
    NotificationReadStore? readStore,
  }) : _readStore = readStore ?? const SessionOnlyNotificationReadStore();

  final ApiClient _api;
  final SessionRepository _session;
  final NotificationReadStore _readStore;

  final ValueNotifier<int> _unread = ValueNotifier<int>(0);

  /// How many read ids we keep on disk. The store MUST be bounded — the events
  /// spine is append-only, so an unpruned id set grows for the life of the
  /// install.
  ///
  /// A CAP, deliberately, rather than "prune ids no longer in the fetched feed".
  /// Pruning to the last response makes the server's answer authoritative about
  /// what to FORGET, and it is not: the feed is capped server-side (limit 50) and
  /// a short/degraded/empty response is indistinguishable from a genuinely short
  /// feed, so one bad fetch would silently wipe every id and resurrect the whole
  /// feed as unread — the exact bug this exists to kill. A cap only ever forgets
  /// ids far OLDER than the server's own window: at 10x the 50-row feed, an id
  /// evicted here cannot still be on screen, so eviction can never resurface a
  /// visible row as unread.
  static const int maxPersistedReadIds = 500;

  /// Ids the worker has marked read (hydrated from [_readStore] on first use),
  /// and the ids from the last fetch (so `markAllRead` doesn't need a re-fetch).
  ///
  /// Insertion-ordered (Dart's Set literal is a LinkedHashSet), which is what
  /// makes the cap oldest-first rather than arbitrary.
  final Set<String> _readIds = <String>{};
  final Set<String> _lastIds = <String>{};

  /// Memoised one-shot hydration, so N concurrent `list()` calls (the Alerts
  /// screen and the shell badge share this singleton and can both refresh) read
  /// prefs once instead of racing.
  Future<void>? _hydration;

  /// Flipped false the first time the store throws. From then on we run exactly
  /// as the old in-memory implementation did — see [_hydrate] for why a broken
  /// store must degrade rather than propagate.
  bool _storeUsable = true;

  @override
  ValueListenable<int> get unreadCount => _unread;

  @override
  Future<List<AppNotification>> list() async {
    final String? token = _session.sessionToken;
    if (token == null) throw const UnauthorizedFailure();
    // Before ANY row is mapped: without this the first fetch of a cold start
    // would map every row as unread and publish that count to the badge, then
    // (maybe) correct itself — a flash of "unread" on alerts already seen.
    await _hydrate();
    try {
      final List<WorkerNotification> rows =
          await _api.getMyNotifications(authToken: token);
      final List<AppNotification> items =
          rows.map(_toNotification).toList(growable: false);
      _lastIds
        ..clear()
        ..addAll(items.map((AppNotification n) => n.id));
      _unread.value = items.where((AppNotification n) => !n.read).length;
      return items;
    } catch (error) {
      throw mapError(error);
    }
  }

  @override
  Future<void> markAllRead() async {
    // Hydrate FIRST, even though the cubit always calls list() before this.
    // [_persist] REPLACES the stored set, so marking read on a set that had not
    // yet absorbed what is on disk would clobber every previously-read id — it
    // would delete read-state instead of adding to it. This is a public
    // interface method; it must be safe called first.
    await _hydrate();
    // Remember the currently-shown ids as read + clear the badge. The cubit
    // re-runs list() after this, which re-maps them as read (unread 0).
    _readIds.addAll(_lastIds);
    _unread.value = 0;
    // …and write them through, so the next cold start still knows. Awaited (not
    // fire-and-forget) so a worker who marks read and immediately kills the app
    // has the write ordered before we return; it cannot throw — see [_persist].
    await _persist();
  }

  @override
  Future<void> refresh() async {
    // Best-effort: populate the badge on app open (before Alerts is opened).
    // Swallows failures (e.g. no token yet) — the badge simply stays at 0.
    try {
      await list();
    } catch (_) {
      // leave the count as-is
    }
  }

  /// Loads the persisted read ids ONCE per process, merging them into whatever
  /// this instance already knows.
  ///
  /// FAIL-SOFT, mirroring the unreadable-secure-store posture in
  /// AuthSessionManager.bootstrap (#355): a store that cannot be read is
  /// indistinguishable from an empty one, so we treat it as "nothing read yet"
  /// and carry on. It must never propagate — the plausible triggers are a
  /// restored backup with a corrupt prefs XML, a plugin that failed to register,
  /// or a full disk, and letting any of those out of here would turn a cosmetic
  /// badge problem into an Alerts screen that shows a failure state and hides
  /// the worker's security alerts entirely. A wrong badge beats no feed.
  ///
  /// Unlike #355 there is nothing to discard: these are opaque event ids, not
  /// credentials, so a bad store is simply abandoned for the rest of the process
  /// ([_storeUsable]) rather than wiped. Latching also stops us re-hitting a
  /// plugin that is provably broken on every markAllRead.
  ///
  /// NOTE the store is INJECTED and defaults to session-only, never to the
  /// `shared_preferences` implementation. `list()` awaits this before it maps a
  /// single row, so a store that never ANSWERS (as opposed to throwing) would
  /// hang the Alerts feed itself: no rows, no badge, no security alerts, and no
  /// error to show. The plugin does exactly that under `flutter_test`'s
  /// FakeAsync, which is why the plugin-backed store is registered only in the
  /// async `initAuthLocator` — see the plugin-free-sync-graph rule documented in
  /// core/di/locator.dart. A timeout here was the wrong fix: it swaps a deadlock
  /// for a pending Timer that fails every widget test that ends first.
  Future<void> _hydrate() {
    return _hydration ??= () async {
      try {
        _readIds.addAll(await _readStore.read());
      } catch (_) {
        // Degrade to the old in-memory behaviour: read-state for this session
        // only. Deliberately swallowed — nothing is logged, since the ids are
        // the worker's own event ids and a log is not a boundary they belong in.
        _storeUsable = false;
      }
    }();
  }

  /// Writes the bounded tail of [_readIds] back to the store. Never throws, for
  /// the same reason [_hydrate] doesn't: failing to remember that an alert was
  /// read must not break marking it read in the UI.
  ///
  /// Only the tail is persisted; the in-memory set keeps everything. The two can
  /// therefore disagree past [maxPersistedReadIds], which is intentional and
  /// harmless — memory is the more generous of the two, and the divergence is
  /// only reachable after 500 marked-read alerts in ONE process.
  Future<void> _persist() async {
    if (!_storeUsable) return;
    // Drop from the FRONT: the set is insertion-ordered, so the head is the
    // oldest-marked-read and the newest ids — the ones still in the feed the
    // worker can see — are the ones kept.
    final int overflow = _readIds.length - maxPersistedReadIds;
    final List<String> ids = overflow > 0
        ? _readIds.skip(overflow).toList(growable: false)
        : _readIds.toList(growable: false);
    try {
      await _readStore.write(ids);
    } catch (_) {
      _storeUsable = false;
    }
  }

  AppNotification _toNotification(WorkerNotification n) {
    return AppNotification(
      id: n.id,
      kind: _kindFor(n.type),
      title: n.title,
      subtitle: n.body,
      time: _relativeTime(n.createdAt),
      read: _readIds.contains(n.id),
    );
  }

  /// Maps the API's coarse `type` to a UI [NotificationKind]. Unknown/new types
  /// fall back to [NotificationKind.security] (a neutral, non-employer tone) so a
  /// future server type never crashes the row.
  NotificationKind _kindFor(String type) {
    switch (type) {
      case 'resume_ready':
      case 'resume_updated':
        return NotificationKind.resumeReady;
      case 'profile_ready':
        return NotificationKind.profileReady;
      case 'voice_processed':
        return NotificationKind.voiceProcessed;
      case 'application_sent':
        return NotificationKind.applicationSent;
      case 'security':
      default:
        return NotificationKind.security;
    }
  }
}

/// A short, Hinglish relative-time label for a notification row (matches the
/// existing display style: "Abhi", "2 ghante", "Kal", …). Purely presentational.
String _relativeTime(DateTime when) {
  final Duration d = DateTime.now().difference(when);
  if (d.isNegative || d.inMinutes < 1) return 'Abhi';
  if (d.inMinutes < 60) return '${d.inMinutes} min';
  if (d.inHours < 24) return '${d.inHours} ghante';
  if (d.inDays == 1) return 'Kal';
  if (d.inDays < 7) return '${d.inDays} din';
  return '${when.day}/${when.month}';
}
