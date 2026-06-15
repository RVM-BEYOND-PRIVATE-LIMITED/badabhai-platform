import 'package:flutter/foundation.dart';

/// Lightweight app-wide state for the Phase 1 scaffold. Uses a plain
/// [ChangeNotifier] to avoid extra state-management dependencies for now.
///
/// Holds only opaque ids returned by the backend — never raw PII beyond the
/// phone the worker is actively entering.
class AppState extends ChangeNotifier {
  AppState._();
  static final AppState instance = AppState._();

  String? phoneE164;
  String? workerId;

  /// Bearer session token minted at OTP verify and required by worker-scoped
  /// API routes (`Authorization: Bearer <token>`). Lives only in memory — it is
  /// the worker's own short-lived session credential, never persisted to disk
  /// and never logged.
  String? sessionToken;

  String? sessionId;
  String? profileId;
  String? resumeId;

  void setWorker({
    required String phone,
    required String workerId,
    String? sessionToken,
  }) {
    phoneE164 = phone;
    this.workerId = workerId;
    if (sessionToken != null) this.sessionToken = sessionToken;
    notifyListeners();
  }

  /// Replaces the in-memory session token. Used when the API hands back a fresh
  /// rolling token via the `x-session-token` response header.
  void setSessionToken(String token) {
    sessionToken = token;
    notifyListeners();
  }

  void setSession(String sessionId) {
    this.sessionId = sessionId;
    notifyListeners();
  }

  void setProfile(String profileId) {
    this.profileId = profileId;
    notifyListeners();
  }

  void setResume(String resumeId) {
    this.resumeId = resumeId;
    notifyListeners();
  }
}
