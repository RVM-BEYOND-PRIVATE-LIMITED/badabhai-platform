import 'package:equatable/equatable.dart';

import '../data/models.dart';
import '../session/app_session.dart';
import 'payer_http.dart';

/// Result of a successful `POST /payer/login/verify` (or the mock equivalent).
///
/// Carries the bearer [accessToken], the opaque [payerId], the server-decided
/// [role] (`employer` | `agent` on the wire), and [isNewPayer]. The token is
/// stored ONLY in secure storage by the caller — never logged, never in a body.
class PayerLoginResult extends Equatable {
  const PayerLoginResult({
    required this.accessToken,
    required this.payerId,
    required this.role,
    required this.isNewPayer,
  });

  final String accessToken;
  final String payerId;

  /// Wire role: `employer` | `agent`. Map to [PayerRole] via [payerRole].
  final String role;
  final bool isNewPayer;

  /// Maps the wire role to the app's [PayerRole]. `agent` → agency, else company.
  PayerRole get payerRole =>
      role == 'agent' ? PayerRole.agency : PayerRole.company;

  factory PayerLoginResult.fromJson(Map<String, dynamic> json) =>
      PayerLoginResult(
        accessToken: json['access_token'] as String? ?? '',
        payerId: json['payer_id'] as String? ?? '',
        role: json['role'] as String? ?? 'employer',
        isNewPayer: json['is_new_payer'] as bool? ?? false,
      );

  @override
  List<Object?> get props =>
      <Object?>[accessToken, payerId, role, isNewPayer];
}

/// The wire role for a chosen [PayerRole] at signup/login.
/// Company → `employer`, Agency → `agent` (per the verified API map).
String wireRoleFor(PayerRole role) => role.isAgency ? 'agent' : 'employer';

/// CONTRACT LAYER for `/payer/*` auth. Every request shape + route lives here so
/// the wire contract is a single-file change. Email + OTP (NOT phone) per the
/// verified API map.
abstract interface class PayerAuthApi {
  /// `POST /payer/signup {role, email, org_name}` — registers a new payer. The
  /// real backend then sends an OTP via `/payer/login/request`.
  Future<void> signup({
    required String role,
    required String email,
    required String orgName,
  });

  /// `POST /payer/login/request {email}` — sends an email OTP.
  Future<void> loginRequest({required String email});

  /// `POST /payer/login/verify {email, code}` → [PayerLoginResult].
  Future<PayerLoginResult> loginVerify({
    required String email,
    required String code,
  });

  /// `POST /payer/refresh` (bearer) — mints a fresh access token. Returns the new
  /// token, or `null` if refresh failed.
  Future<String?> refresh();

  /// `POST /payer/logout` — 204. Best-effort server-side session end.
  Future<void> logout();
}

/// Real `/payer/*` auth over [PayerHttp].
class HttpPayerAuthApi implements PayerAuthApi {
  HttpPayerAuthApi(this._http);

  final PayerHttp _http;

  @override
  Future<void> signup({
    required String role,
    required String email,
    required String orgName,
  }) async {
    final PayerResponse res = await _http.send(
      PayerMethod.post,
      '/payer/signup',
      authed: false,
      body: <String, dynamic>{
        'role': role,
        'email': email,
        'org_name': orgName,
      },
    );
    // A rejected signup (400 empty/oversize org_name, 429 IP cap, 5xx) must not
    // be swallowed as success — the caller would then wrongly proceed to request
    // an OTP that never comes. Surface it. (An existing payer is a 200 via
    // createOrGet, so this never blocks a returning login.)
    if (!res.isSuccess) throw PayerApiException(res.statusCode);
  }

  @override
  Future<void> loginRequest({required String email}) async {
    final PayerResponse res = await _http.send(
      PayerMethod.post,
      '/payer/login/request',
      authed: false,
      body: <String, dynamic>{'email': email},
    );
    // #347 — the SAME rule signup() above already enforces, applied to the leg
    // that actually sends the OTP. PayerHttp.send returns non-2xx instead of
    // throwing, so a 429 (per-email OTP cap) or 5xx completed "successfully" and
    // LoginScreen flipped to "We sent a 6-digit code to <email>" for a code that
    // was never sent — the payer then waits for an email that will not arrive and
    // loops on "That code did not work" with no honest rate-limit message.
    if (!res.isSuccess) throw PayerApiException(res.statusCode);
  }

  @override
  Future<PayerLoginResult> loginVerify({
    required String email,
    required String code,
  }) async {
    final PayerResponse res = await _http.send(
      PayerMethod.post,
      '/payer/login/verify',
      authed: false,
      body: <String, dynamic>{'email': email, 'code': code},
    );
    // #347 — deliberately NARROWER than a blanket !isSuccess guard. A wrong or
    // expired code is a 4xx VERDICT ON THE CODE, and the existing empty-
    // accessToken path already renders its precise copy ("That code did not
    // work") — throwing here would replace that with a vaguer error. But a 429
    // (attempt cap) or a 5xx is not a verdict on the code at all: swallowing
    // those told a payer their CORRECT code was wrong and sent them into a retry
    // loop that burned the cap further. Those, and only those, throw.
    if (res.statusCode == 429 || res.statusCode >= 500) {
      throw PayerApiException(res.statusCode);
    }
    return PayerLoginResult.fromJson(res.body);
  }

  @override
  Future<String?> refresh() async {
    final PayerResponse res = await _http.send(PayerMethod.post, '/payer/refresh');
    if (!res.isSuccess) return null;
    final String? token = res.body['access_token'] as String?;
    return (token != null && token.isNotEmpty) ? token : null;
  }

  @override
  Future<void> logout() async {
    await _http.send(PayerMethod.post, '/payer/logout');
  }
}

/// Mock `/payer/*` auth — any email/code "works" and signs in. Used in MOCK mode
/// so the whole login flow is walkable with no backend. Never touches the wire.
class MockPayerAuthApi implements PayerAuthApi {
  MockPayerAuthApi();

  /// Remembers the role chosen at signup/request so verify can echo it back, the
  /// way the real server decides role from the registered payer.
  String _role = 'employer';

  @override
  Future<void> signup({
    required String role,
    required String email,
    required String orgName,
  }) async {
    _role = role;
  }

  @override
  Future<void> loginRequest({required String email}) async {}

  @override
  Future<PayerLoginResult> loginVerify({
    required String email,
    required String code,
  }) async {
    // Any non-empty code is accepted in MOCK mode.
    return PayerLoginResult(
      accessToken: 'mock-payer-token',
      payerId: 'mock-payer-id',
      role: _role,
      isNewPayer: false,
    );
  }

  /// MOCK mode can carry the role from the login screen so verify echoes it.
  // ignore: use_setters_to_change_properties
  void setRole(String role) => _role = role;

  @override
  Future<String?> refresh() async => 'mock-payer-token';

  @override
  Future<void> logout() async {}
}
