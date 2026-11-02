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
/// the wire contract is a single-file change.
///
/// A payer can sign up with an EMAIL or a PHONE (OTP to either), then set a
/// password. Subsequent logins use `identifier + password`, where the identifier
/// is an email, an E.164 phone, or the account's exact company/agency name.
/// The older OTP-only login stays available for accounts without a password.
abstract interface class PayerAuthApi {
  /// `POST /payer/signup {role, org_name, email? | phone?}` — create-or-get the
  /// account and send a signup OTP to the supplied contact. At least one of
  /// [email] / [phone] is required.
  Future<void> signup({
    required String role,
    required String orgName,
    String? email,
    String? phone,
  });

  /// `POST /payer/login/request {email? | phone?}` — sends a login OTP.
  Future<void> loginRequest({String? email, String? phone});

  /// `POST /payer/login/verify {email? | phone?, code}` → [PayerLoginResult].
  Future<PayerLoginResult> loginVerify({
    String? email,
    String? phone,
    required String code,
  });

  /// `POST /payer/password/set {password}` (bearer) — sets/replaces the payer's
  /// password. Called with the OTP-verify token BEFORE the session is persisted,
  /// so a payer who abandons the password step is not left signed in.
  Future<void> setPassword({
    required String accessToken,
    required String password,
  });

  /// `POST /payer/login/password {identifier, password}` → [PayerLoginResult].
  /// [identifier] is an email, an E.164 phone, or an exact company name.
  Future<PayerLoginResult> loginWithPassword({
    required String identifier,
    required String password,
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
    required String orgName,
    String? email,
    String? phone,
  }) async {
    if ((email == null || email.isEmpty) && (phone == null || phone.isEmpty)) {
      throw ArgumentError('signup needs an email or a phone');
    }
    final PayerResponse res = await _http.send(
      PayerMethod.post,
      '/payer/signup',
      authed: false,
      body: <String, dynamic>{
        'role': role,
        'org_name': orgName,
        if (email != null && email.isNotEmpty) 'email': email,
        if (phone != null && phone.isNotEmpty) 'phone': phone,
      },
    );
    // A rejected signup (400 empty/oversize org_name, 429 IP cap, 5xx) must not
    // be swallowed as success — the caller would then wrongly proceed to request
    // an OTP that never comes. (An existing payer is a 200 via
    // createOrGet, so this never blocks a returning login.)
    if (!res.isSuccess) throw PayerApiException(res.statusCode);
  }

  @override
  Future<void> loginRequest({String? email, String? phone}) async {
    if ((email == null || email.isEmpty) && (phone == null || phone.isEmpty)) {
      throw ArgumentError('loginRequest needs an email or a phone');
    }
    final PayerResponse res = await _http.send(
      PayerMethod.post,
      '/payer/login/request',
      authed: false,
      body: <String, dynamic>{
        if (email != null && email.isNotEmpty) 'email': email,
        if (phone != null && phone.isNotEmpty) 'phone': phone,
      },
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
    String? email,
    String? phone,
    required String code,
  }) async {
    if ((email == null || email.isEmpty) && (phone == null || phone.isEmpty)) {
      throw ArgumentError('loginVerify needs an email or a phone');
    }
    final PayerResponse res = await _http.send(
      PayerMethod.post,
      '/payer/login/verify',
      authed: false,
      body: <String, dynamic>{
        if (email != null && email.isNotEmpty) 'email': email,
        if (phone != null && phone.isNotEmpty) 'phone': phone,
        'code': code,
      },
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
  Future<void> setPassword({
    required String accessToken,
    required String password,
  }) async {
    final PayerResponse res = await _http.send(
      PayerMethod.post,
      '/payer/password/set',
      // The verify token from THIS signup, not the persisted store: the session
      // is only saved once the password is set.
      bearerOverride: accessToken,
      body: <String, dynamic>{'password': password},
    );
    if (!res.isSuccess) throw PayerApiException(res.statusCode);
  }

  @override
  Future<PayerLoginResult> loginWithPassword({
    required String identifier,
    required String password,
  }) async {
    final PayerResponse res = await _http.send(
      PayerMethod.post,
      '/payer/login/password',
      authed: false,
      body: <String, dynamic>{'identifier': identifier, 'password': password},
    );
    // A wrong password / unknown identifier is a neutral 401; a 429 cap or 5xx
    // must not be reported as "wrong password".
    if (!res.isSuccess) throw PayerApiException(res.statusCode);
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

/// Mock `/payer/*` auth — walkable with no backend.
///
/// It now remembers the account created by [signup] (role, org, contact,
/// password) so the full signup → password → login flow works in MOCK mode, and
/// a wrong password is a 401 like the real server. Any OTP code is accepted.
class MockPayerAuthApi implements PayerAuthApi {
  MockPayerAuthApi();

  /// Remembers the role chosen at signup/request so verify can echo it back, the
  /// way the real server decides role from the registered payer.
  String _role = 'employer';
  String? _email;
  String? _phone;
  String? _orgName;
  String? _password;

  @override
  Future<void> signup({
    required String role,
    required String orgName,
    String? email,
    String? phone,
  }) async {
    _role = role;
    _orgName = orgName.trim();
    _email = email?.trim();
    _phone = phone?.trim();
  }

  @override
  Future<void> loginRequest({String? email, String? phone}) async {
    if (email != null && email.isNotEmpty) _email = email.trim();
    if (phone != null && phone.isNotEmpty) _phone = phone.trim();
  }

  @override
  Future<PayerLoginResult> loginVerify({
    String? email,
    String? phone,
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

  @override
  Future<void> setPassword({
    required String accessToken,
    required String password,
  }) async {
    _password = password;
  }

  @override
  Future<PayerLoginResult> loginWithPassword({
    required String identifier,
    required String password,
  }) async {
    // A stored password must match; an unknown identifier is the same neutral
    // 401 the real route returns. The identifier may be the email, the phone,
    // or the exact company name (case-insensitive), as on the wire.
    final String id = identifier.trim().toLowerCase();
    final bool matches = id == (_email?.toLowerCase() ?? '\u0000') ||
        id == (_phone ?? '\u0000') ||
        id == (_orgName?.toLowerCase() ?? '\u0000');
    if (!matches || _password == null || password != _password) {
      throw const PayerApiException(401);
    }
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
