import 'package:flutter/foundation.dart';

/// App-wide reachability, derived from REAL API traffic (#2690, rule 3).
///
/// The HTTP layer reports a completed response as online and a transport
/// failure (timeout / dead socket / TLS) as offline. There is no polling and no
/// extra request: the payer's own calls are the probe. The shell listens and
/// shows one slim banner until the next successful call.
class NetworkStatus extends ChangeNotifier {
  bool _online = true;

  /// True until a transport failure says otherwise.
  bool get online => _online;

  /// True while the payer is offline (banner visible).
  bool get offline => !_online;

  /// Records a completed round-trip (any HTTP status, even a 5xx — the server
  /// answered, so the connection is back).
  void markOnline() => _set(true);

  /// Records a transport failure.
  void markOffline() => _set(false);

  void _set(bool online) {
    if (_online == online) return;
    _online = online;
    notifyListeners();
  }
}
