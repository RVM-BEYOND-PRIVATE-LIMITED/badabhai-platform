import 'auth_api.dart';
import 'secure_token_store.dart';

/// A no-network [AuthApi] for the USE_MOCKS walkable path.
///
/// Selected by `createAuthApi` when `--dart-define=USE_MOCKS=true`. It OVERRIDES
/// every public method to return canned, PII-FREE data after a short delay (so
/// loading states still render) and NEVER calls `super` / touches HTTP. It writes
/// the same [SecureTokenStore] the real path uses, so PASS 2 can walk
/// phone → OTP → set/enter PIN → shell → refresh → logout → devices entirely
/// offline.
///
/// PII-FREE BY CONTRACT (CLAUDE.md §2): every token is an obvious `mock-*`
/// sentinel; the device list is canned and generic — no real phone / name /
/// device fingerprint reaches state or logs.
///
/// MAINTENANCE: any NEW public method on [AuthApi] MUST get a matching override
/// here, mirroring the MockApiClient invariant.
class MockAuthApi extends AuthApi {
  MockAuthApi(this._tokenStore) : super.withoutClient();

  final SecureTokenStore _tokenStore;

  static const Duration _latency = Duration(milliseconds: 300);

  /// In-memory mock PIN state for this process — flips to true after [pinSet] so
  /// the next OTP verify reports `pinSet: true`.
  bool _pinSet = false;

  Future<void> _delay() => Future<void>.delayed(_latency);

  @override
  Future<OtpRequestResult> otpRequest(String phoneE164) async {
    await _delay();
    return OtpRequestResult.fromJson(
      <String, dynamic>{'resend_in_seconds': 30},
    );
  }

  @override
  Future<OtpVerifyResult> otpVerify(String phoneE164, String otp) async {
    await _delay();
    final DateTime expiresAt = DateTime.now().add(const Duration(minutes: 15));
    await _tokenStore.saveTokens(
      refreshToken: 'mock-refresh-token',
      accessExpiresAt: expiresAt,
      accessToken: 'mock-access-token',
    );
    await _tokenStore.writeWorkerId('mock-worker-0001');
    await _tokenStore.writePinSet(_pinSet);
    return OtpVerifyResult(
      workerId: 'mock-worker-0001',
      isNewUser: !_pinSet,
      pinSet: _pinSet,
      tokens: AuthTokens(
        access: 'mock-access-token',
        refresh: 'mock-refresh-token',
        accessExpiresAt: expiresAt,
      ),
    );
  }

  @override
  Future<void> pinSet(String pin) async {
    await _delay();
    _pinSet = true;
    await _tokenStore.writePinSet(true);
  }

  @override
  Future<AuthTokens> pinVerify(String pin, {required String refreshToken}) async {
    await _delay();
    return _mintMockTokens();
  }

  @override
  Future<AuthTokens> tokenRefresh(String refreshToken) async {
    await _delay();
    return _mintMockTokens();
  }

  @override
  Future<void> logout() async {
    await _delay();
    await _tokenStore.clear();
  }

  @override
  Future<List<AuthDevice>> listDevices() async {
    await _delay();
    return <AuthDevice>[
      AuthDevice(
        deviceId: await _tokenStore.readDeviceId() ?? 'mock-device-current',
        label: 'This phone',
        lastSeenAt: DateTime.now(),
        current: true,
      ),
      AuthDevice(
        deviceId: 'mock-device-0002',
        label: 'Old phone',
        lastSeenAt: DateTime.now().subtract(const Duration(days: 3)),
        current: false,
      ),
    ];
  }

  @override
  Future<void> revokeDevice(String deviceId) async {
    await _delay();
    // No-op in mock mode — the canned device list is regenerated on next read.
  }

  Future<AuthTokens> _mintMockTokens() async {
    final DateTime expiresAt = DateTime.now().add(const Duration(minutes: 15));
    await _tokenStore.saveTokens(
      refreshToken: 'mock-refresh-token',
      accessExpiresAt: expiresAt,
      accessToken: 'mock-access-token',
    );
    return AuthTokens(
      access: 'mock-access-token',
      refresh: 'mock-refresh-token',
      accessExpiresAt: expiresAt,
    );
  }
}
