import 'dart:async';
import 'package:flutter/services.dart';
import '../auth/auth_api.dart';

class PushTokenService {
  PushTokenService(this._authApi) {
    _channel.setMethodCallHandler(_handleMethodCall);
  }

  final AuthApi _authApi;
  final MethodChannel _channel = const MethodChannel('badabhai/push_token');

  static const Duration _retryDelay = Duration(seconds: 5);
  static const int _maxRetries = 3;

  Future<String?> getNativeToken() async {
    try {
      final String? token = await _channel.invokeMethod<String>('getToken');
      return token;
    } on MissingPluginException {
      return null;
    }
  }

  Future<String?> registerCurrentToken() async {
    final String? token = await getNativeToken();
    if (token == null || token.isEmpty) return null;
    return _sendToken(token, attempt: 0);
  }

  Stream<String> get tokenUpdates {
    return _tokenController.stream;
  }

  final StreamController<String> _tokenController =
      StreamController<String>.broadcast();

  Future<void> _handleMethodCall(MethodCall call) async {
    if (call.method == 'tokenUpdated') {
      final String token = call.arguments as String;
      _tokenController.add(token);
      _sendToken(token);
    }
  }

  Future<String?> _sendToken(String token, {int attempt = 0}) async {
    try {
      return await _authApi.updatePushToken(token);
    } catch (_) {
      if (attempt < _maxRetries) {
        await Future<void>.delayed(_retryDelay);
        return _sendToken(token, attempt: attempt + 1);
      }
      return null;
    }
  }

  void dispose() {
    _channel.setMethodCallHandler(null);
    _tokenController.close();
  }
}
