import 'dart:async';
import 'dart:convert';
import 'dart:io' show Platform;

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:package_info_plus/package_info_plus.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../config/app_config.dart' show resolvePayerApiBaseUrl;

/// #3049 — the payer (company) app's half of "minimum supported app build"
/// (#3048). Same behaviour as the worker app's: one set of headers on every
/// request, a start-up and foreground read of `GET /app-config`, a
/// non-dismissible page below the minimum, a once-a-day notice below the latest,
/// and a 426 from any request showing the same page. A failed config read lets
/// the payer in.
const String kAppUpdateRequiredCode = 'APP_UPDATE_REQUIRED';
const String kDefaultAppMessageKey = 'update_default';
const String kPayerAppName = 'payer';

class AppUpdateConfig {
  const AppUpdateConfig({
    required this.minSupportedBuild,
    required this.latestBuild,
    required this.storeUrl,
    required this.messageKey,
  });

  final int minSupportedBuild;
  final int latestBuild;
  final String? storeUrl;
  final String messageKey;

  static AppUpdateConfig? tryParse(Object? raw) {
    if (raw is! Map) return null;
    final Object? min = raw['min_supported_build'];
    final Object? latest = raw['latest_build'];
    if (min is! num || latest is! num) return null;
    final Object? url = raw['store_url'];
    final Object? key = raw['message_key'];
    return AppUpdateConfig(
      minSupportedBuild: min.toInt(),
      latestBuild: latest.toInt(),
      storeUrl: url is String && url.isNotEmpty ? url : null,
      messageKey: key is String && key.isNotEmpty ? key : kDefaultAppMessageKey,
    );
  }
}

bool isAppUpdateRequiredResponse(int statusCode, Map<String, dynamic>? body) {
  if (statusCode != 426 || body == null) return false;
  final Object? error = body['error'];
  final Map<dynamic, dynamic>? envelope = error is Map ? error : null;
  final Object? code = body['code'] ?? envelope?['code'];
  return code == kAppUpdateRequiredCode;
}

AppUpdateConfig? appUpdateConfigFromBody(Map<String, dynamic>? body) {
  if (body == null) return null;
  final Object? error = body['error'];
  final Map<dynamic, dynamic>? envelope = error is Map ? error : null;
  return AppUpdateConfig.tryParse(body['config'] ?? envelope?['config']);
}

/// The headers every payer request sends (#3049). Set by [AppUpdateController.init]
/// before the first request.
class AppRequestIdentity {
  AppRequestIdentity._();

  static String platform = _detectPlatform();
  static int? buildNumber;

  static String _detectPlatform() {
    if (kIsWeb) return 'android';
    if (Platform.isIOS) return 'ios';
    return 'android';
  }

  static Map<String, String> headers() => <String, String>{
        'x-app-name': kPayerAppName,
        'x-app-platform': platform,
        if (buildNumber != null) 'x-app-build-number': '$buildNumber',
      };
}

class AppUpdateSignal {
  AppUpdateSignal._();
  static final AppUpdateSignal instance = AppUpdateSignal._();

  final StreamController<AppUpdateConfig?> _controller =
      StreamController<AppUpdateConfig?>.broadcast();

  Stream<AppUpdateConfig?> get stream => _controller.stream;

  void fire(AppUpdateConfig? config) {
    if (!_controller.isClosed) _controller.add(config);
  }
}

/// The app-scoped update state the payer root listens to. A failed read leaves
/// the payer in.
class AppUpdateController extends ChangeNotifier {
  AppUpdateController._();
  static final AppUpdateController instance = AppUpdateController._();

  static const String _dismissedKey = 'app_update_notice_dismissed_on';
  static const Duration _configTimeout = Duration(seconds: 10);

  bool _blocking = false;
  bool _notice = false;
  AppUpdateConfig? _config;
  int? _buildNumber;
  String _platform = AppRequestIdentity.platform;
  http.Client? _client;
  StreamSubscription<AppUpdateConfig?>? _subscription;
  SharedPreferences? _prefs;
  DateTime Function() _now = DateTime.now;
  bool _started = false;

  bool get blocking => _blocking;
  bool get notice => _notice;
  String? get storeUrl => _config?.storeUrl;
  int? get buildNumber => _buildNumber;

  Future<void> init({
    http.Client? client,
    String? platform,
    int? buildNumber,
    Future<SharedPreferences> Function()? prefs,
    DateTime Function()? now,
  }) async {
    if (_started) return;
    _started = true;
    _client = client ?? http.Client();
    _platform = platform ?? AppRequestIdentity._detectPlatform();
    _now = now ?? DateTime.now;
    AppRequestIdentity.platform = _platform;

    int? build = buildNumber;
    if (build == null) {
      try {
        final PackageInfo info = await PackageInfo.fromPlatform();
        build = int.tryParse(info.buildNumber);
      } catch (_) {
        build = null;
      }
    }
    _buildNumber = build;
    AppRequestIdentity.buildNumber = build;

    try {
      _prefs = await (prefs ?? SharedPreferences.getInstance)();
    } catch (_) {
      _prefs = null;
    }

    _subscription ??= AppUpdateSignal.instance.stream.listen(onUpdateRequired);
  }

  Future<void> refresh() async {
    final http.Client? client = _client;
    if (client == null) return;
    try {
      final Uri uri =
          Uri.parse('${resolvePayerApiBaseUrl()}/app-config').replace(
        queryParameters: <String, String>{
          'app': kPayerAppName,
          'platform': _platform,
        },
      );
      final http.Response res = await client.get(uri).timeout(_configTimeout);
      if (res.statusCode != 200) return;
      final Object? decoded = jsonDecode(res.body);
      final AppUpdateConfig? config = decoded is Map<String, dynamic>
          ? AppUpdateConfig.tryParse(decoded)
          : null;
      if (config == null) return;
      _apply(config);
    } catch (_) {
      // A network fault must never lock a payer out.
    }
  }

  void onUpdateRequired(AppUpdateConfig? config) {
    if (config != null) _config = config;
    _blocking = true;
    _notice = false;
    notifyListeners();
  }

  void dismissNotice() {
    _notice = false;
    final String today = _day(_now());
    _prefs?.setString(_dismissedKey, today);
    notifyListeners();
  }

  void _apply(AppUpdateConfig config) {
    _config = config;
    final int build = _buildNumber ?? 0;
    if (build < config.minSupportedBuild) {
      _blocking = true;
      _notice = false;
    } else if (build < config.latestBuild) {
      _blocking = false;
      _notice = _prefs?.getString(_dismissedKey) != _day(_now());
    } else {
      _blocking = false;
      _notice = false;
    }
    notifyListeners();
  }

  String _day(DateTime value) => '${value.year.toString().padLeft(4, '0')}-'
      '${value.month.toString().padLeft(2, '0')}-'
      '${value.day.toString().padLeft(2, '0')}';

  /// Clears the singleton between tests. Never called by the app.
  @visibleForTesting
  void resetForTest() {
    unawaited(_subscription?.cancel());
    _subscription = null;
    _client?.close();
    _client = null;
    _prefs = null;
    _blocking = false;
    _notice = false;
    _config = null;
    _buildNumber = null;
    _platform = AppRequestIdentity._detectPlatform();
    _now = DateTime.now;
    _started = false;
    AppRequestIdentity.buildNumber = null;
  }

  @override
  void dispose() {
    unawaited(_subscription?.cancel());
    super.dispose();
  }
}

String appUpdateLanguage() =>
    PlatformDispatcher.instance.locale.languageCode == 'hi' ? 'hi' : 'en';
