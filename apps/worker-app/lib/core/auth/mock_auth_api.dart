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
      // TD62: the standard mock walkthrough is a consented worker, so the
      // client consent gate never blocks the USE_MOCKS flows.
      consentAccepted: true,
    );
  }

  @override
  Future<void> pinSet(String pin) async {
    await _delay();
    _pinSet = true;
    await _tokenStore.writePinSet(true);
  }

  @override
  Future<PinVerifyResult> pinVerify(String pin,
      {required String refreshToken}) async {
    await _delay();
    // TD62: consistent with otpVerify — the mock walkthrough is consented.
    return PinVerifyResult(
      tokens: await _mintMockTokens(),
      consentAccepted: true,
    );
  }

  @override
  Future<AuthTokens> tokenRefresh(String refreshToken) async {
    await _delay();
    return _mintMockTokens();
  }

  @override
  Future<MeResult> me() async {
    await _delay();
    // ADR-0031: no deletion pending on the mock walkthrough. That is the HONEST
    // answer, not a convenient one — the mock delete flow lives in
    // MockApiClient and its scheduled date is in-memory only, so a fresh
    // process (which is what a cold start is) genuinely has nothing scheduled.
    return const MeResult(workerId: 'mock-worker-0001', status: 'active');
  }

  @override
  Future<void> logout() async {
    await _delay();
    await _tokenStore.clear();
  }

  @override
  Future<List<AuthDevice>> listDevices() async {
    await _delay();
    // Mirrors the real GET /auth/devices DeviceListItem shape (id / platform /
    // model / is_current — no `label`; the UI derives the label from platform +
    // model). PII-FREE: generic canned descriptors only.
    return <AuthDevice>[
      AuthDevice(
        id: await _tokenStore.readDeviceId() ?? 'mock-device-current',
        platform: 'android',
        model: 'This phone',
        appVersion: '0.1.0',
        trustedAt: DateTime.now().subtract(const Duration(days: 1)),
        lastSeenAt: DateTime.now(),
        isCurrent: true,
      ),
      AuthDevice(
        id: 'mock-device-0002',
        platform: 'android',
        model: 'Old phone',
        appVersion: '0.1.0',
        trustedAt: DateTime.now().subtract(const Duration(days: 30)),
        lastSeenAt: DateTime.now().subtract(const Duration(days: 3)),
        isCurrent: false,
      ),
    ];
  }

  @override
  Future<void> revokeDevice(String deviceId) async {
    await _delay();
    // No-op in mock mode — the canned device list is regenerated on next read.
  }

  @override
  Future<void> pinResetRequest(String phoneE164) async {
    await _delay();
    // Canned success — mirrors POST /auth/pin/reset/request {phone} → 200.
  }

  @override
  Future<void> pinResetConfirm(String phoneE164, String otp, String pin) async {
    await _delay();
    // Canned success — mirrors POST /auth/pin/reset/confirm → 204. The reset
    // leaves the persisted refresh token intact so the worker can unlock with
    // the new PIN; flip the in-process pin_set flag accordingly.
    _pinSet = true;
    await _tokenStore.writePinSet(true);
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
