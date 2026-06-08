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
  String? sessionId;
  String? profileId;
  String? resumeId;

  void setWorker({required String phone, required String workerId}) {
    phoneE164 = phone;
    this.workerId = workerId;
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
