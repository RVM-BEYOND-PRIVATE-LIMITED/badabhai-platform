import 'package:flutter/foundation.dart';

import '../../../core/api/api_client.dart';
import '../../../core/error/failure.dart';
import '../../../core/error/failure_mapper.dart';
import '../../../core/session/session_repository.dart';
import '../domain/app_notification.dart';
import '../domain/notifications_repository.dart';

/// Real worker-scoped Alerts feed (follows the applications/resume real-repo
/// pattern: ctor takes [ApiClient] + [SessionRepository]).
///
/// Reads GET /workers/me/notifications — a FACELESS, PII-FREE projection of the
/// worker's own real events (copy is server-rendered; no employer/pay/name/phone)
/// — and maps the rows into [AppNotification]s for the UI, unchanged.
///
/// READ-STATE is SESSION-LOCAL: the `events` spine is append-only (no server
/// read-state store), so `markAllRead` clears the badge for this session only.
/// Registered as a lazySingleton so the Alerts screen and the shell badge share
/// one instance (and the same session read-state).
class NotificationsRepositoryImpl implements NotificationsRepository {
  NotificationsRepositoryImpl(this._api, this._session);

  final ApiClient _api;
  final SessionRepository _session;

  final ValueNotifier<int> _unread = ValueNotifier<int>(0);

  /// Ids the worker has marked read THIS session (append-only spine has no
  /// server read-state), and the ids from the last fetch (so `markAllRead`
  /// doesn't need a re-fetch).
  final Set<String> _readIds = <String>{};
  final Set<String> _lastIds = <String>{};

  @override
  ValueListenable<int> get unreadCount => _unread;

  @override
  Future<List<AppNotification>> list() async {
    final String? token = _session.sessionToken;
    if (token == null) throw const UnauthorizedFailure();
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
    // Session-local: remember the currently-shown ids as read + clear the badge.
    // The cubit re-runs list() after this, which re-maps them as read (unread 0).
    _readIds.addAll(_lastIds);
    _unread.value = 0;
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
