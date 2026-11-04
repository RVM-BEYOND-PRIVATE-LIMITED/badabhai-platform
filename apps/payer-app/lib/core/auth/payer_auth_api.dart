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

/// What `POST /payer/login/password` answered (#2597).
///
/// Sealed so every caller must handle the forced-change case. ONLY
/// [PayerPasswordSignedIn] carries a session, and it is only ever built from a
/// body with a non-empty `access_token` — fail closed by construction.
sealed class PayerPasswordLoginOutcome {
  const PayerPasswordLoginOutcome();
}

/// A real session: [session] carries a non-empty bearer.
final class PayerPasswordSignedIn extends PayerPasswordLoginOutcome {
  const PayerPasswordSignedIn(this.session);

  final PayerLoginResult session;
}

/// `200 {"status":"password_change_required"}` — the password was a TEMPORARY
/// one an admin issued (backend #2563). NO session: the payer must choose a new
/// password and the request is resent with `new_password`.
final class PayerPasswordChangeRequired extends PayerPasswordLoginOutcome {
  const PayerPasswordChangeRequired();
}

/// `POST /payer/login/verify` answered 409 (#2597): the account holds an
/// admin-issued temporary password (#2563), so the code door refuses to open a
/// session until that password is replaced through password sign-in.
///
/// A [PayerApiException] (409) so every existing `catch` keeps working; the TYPE
/// is the discriminator. The server sends it only after the code proved the
/// mailbox, so it is not an account-existence oracle.
class PayerPasswordChangeRequiredException extends PayerApiException {
  const PayerPasswordChangeRequiredException() : super(409);
}

/// The wire `status` of the forced-change answer (#2563).
const String _kPasswordChangeRequired = 'password_change_required';

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
  /// Throws [PayerPasswordChangeRequiredException] when the account holds a
  /// temporary password (409, #2563) — no session.
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

  /// `POST /payer/login/password {identifier, password, new_password?}`.
  /// [identifier] is an email, an E.164 phone, or an exact company name.
  ///
  /// #2597 — a temporary password answers [PayerPasswordChangeRequired] (no
  /// session); resending with [newPassword] replaces it and answers
  /// [PayerPasswordSignedIn]. A refused [newPassword] is a 400 whose
  /// [PayerApiException.validationMessage] carries the server's reason.
  Future<PayerPasswordLoginOutcome> loginWithPassword({
    required String identifier,
    required String password,
    String? newPassword,
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
    // #2597 — the code door refuses an account holding a temporary password
    // (#2563): 409, no session. Its own type, so the screen can send the payer
    // to password sign-in instead of "That code did not work". A server without
    // #2563 never answers 409 here.
    if (res.statusCode == 409) {
      throw const PayerPasswordChangeRequiredException();
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
  Future<PayerPasswordLoginOutcome> loginWithPassword({
    required String identifier,
    required String password,
    String? newPassword,
  }) async {
    final PayerResponse res = await _http.send(
      PayerMethod.post,
      '/payer/login/password',
      authed: false,
      body: <String, dynamic>{
        'identifier': identifier,
        'password': password,
        // #2597 — only on the forced-change resend.
        if (newPassword != null) 'new_password': newPassword,
      },
    );
    // A wrong password / unknown identifier is a neutral 401; a 429 cap or 5xx
    // must not be reported as "wrong password".
    if (!res.isSuccess) {
      throw PayerApiException(
        res.statusCode,
        validationMessage: newPassword != null && res.statusCode == 400
            ? _newPasswordRejection(res.body)
            : null,
      );
    }
    // #2597 — FAIL CLOSED. The forced-change answer is never a session, even if
    // a token rode along; any other 2xx without a bearer is contract breakage,
    // not a signed-in payer (an empty token must never reach the store).
    if (res.body['status'] == _kPasswordChangeRequired) {
      return const PayerPasswordChangeRequired();
    }
    final Object? token = res.body['access_token'];
    if (token is! String || token.isEmpty) {
      throw PayerApiException(res.statusCode);
    }
    return PayerPasswordSignedIn(PayerLoginResult.fromJson(res.body));
  }

  /// The server's reason a NEW password was refused (#2563), or null.
  ///
  /// A policy miss is a validation issue on `new_password` inside the global
  /// `{ error: { issues: [{ path, message }] } }` envelope; "same as the
  /// temporary one" is a plain `error.message`. The server names the rule, never
  /// the password, so the text is safe to render.
  static String? _newPasswordRejection(Map<String, dynamic> body) {
    final Object? error = body['error'];
    if (error is! Map) return null;
    final Object? issues = error['issues'];
    if (issues is List) {
      for (final Object? issue in issues) {
        if (issue is Map && issue['path'] == 'new_password') {
          final Object? message = issue['message'];
          if (message is String && message.trim().isNotEmpty) {
            return message.trim();
          }
        }
      }
      // A validation miss on another field says nothing about the new one.
      return null;
    }
    final Object? message = error['message'];
    if (message is! String) return null;
    final String text = message.trim();
    if (text.isEmpty || text == 'Validation failed' || text == 'Bad Request') {
      return null;
    }
    return text;
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
///
/// #2597 — [issueTemporaryPassword] (OPT-IN; never called by default, so MOCK
/// mode behaves exactly as before) stands up an admin-issued temporary-password
/// account that answers like backend #2563.
class MockPayerAuthApi implements PayerAuthApi {
  MockPayerAuthApi();

  /// Remembers the role chosen at signup/request so verify can echo it back, the
  /// way the real server decides role from the registered payer.
  String _role = 'employer';
  String? _email;
  String? _phone;
  String? _orgName;
  String? _password;

  /// True while [_password] is a temporary one an admin issued (#2563).
  bool _mustChangePassword = false;

  /// #2597 — OPT-IN: the account an admin creates with a temporary password
  /// (#2563). Password sign-in then answers [PayerPasswordChangeRequired] until a
  /// policy-valid, different `new_password` is sent; code sign-in with this
  /// contact answers 409 ([PayerPasswordChangeRequiredException]).
  void issueTemporaryPassword({
    required String temporaryPassword,
    String role = 'employer',
    String? email,
    String? phone,
    String? orgName,
  }) {
    _role = role;
    if (email != null) _email = email.trim();
    if (phone != null) _phone = phone.trim();
    if (orgName != null) _orgName = orgName.trim();
    _password = temporaryPassword;
    _mustChangePassword = true;
  }

  /// The server's `PasswordPolicySchema` 400 text for [password], in the
  /// server's check order, or null when it passes. Mirrors the SERVER (not the
  /// app's own policy copy) so a drift between the two would show up here.
  static String? _serverPolicyRejection(String password) {
    if (password.length < 8) return 'Password must be at least 8 characters';
    if (password.length > 128) return 'Password must be at most 128 characters';
    if (!RegExp(r'^(?=.*[A-Za-z])(?=.*\d).+$').hasMatch(password)) {
      return 'Password must include at least one letter and one digit';
    }
    return null;
  }

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
    // #2597 — like #2563, the code door refuses a temporary-password account.
    if (_mustChangePassword && _isAccountContact(email: email, phone: phone)) {
      throw const PayerPasswordChangeRequiredException();
    }
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
    // A self-set password is the payer's own, never a temporary one (#2563).
    _mustChangePassword = false;
  }

  @override
  Future<PayerPasswordLoginOutcome> loginWithPassword({
    required String identifier,
    required String password,
    String? newPassword,
  }) async {
    // Like the server's validation pipe, a policy-failing new password is a 400
    // before any credential check.
    if (newPassword != null) {
      final String? policy = _serverPolicyRejection(newPassword);
      if (policy != null) {
        throw PayerApiException(400, validationMessage: policy);
      }
    }
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
    // #2597 — a temporary password proves the account but opens no session.
    if (_mustChangePassword) {
      if (newPassword == null) return const PayerPasswordChangeRequired();
      if (newPassword == password) {
        throw const PayerApiException(
          400,
          validationMessage:
              'Choose a new password - it cannot be the temporary one',
        );
      }
      _password = newPassword;
      _mustChangePassword = false;
    }
    return PayerPasswordSignedIn(
      PayerLoginResult(
        accessToken: 'mock-payer-token',
        payerId: 'mock-payer-id',
        role: _role,
        isNewPayer: false,
      ),
    );
  }

  /// Whether [email]/[phone] name the remembered account.
  bool _isAccountContact({String? email, String? phone}) {
    final String? mail = email?.trim().toLowerCase();
    final String? tel = phone?.trim();
    return (mail != null && mail.isNotEmpty && mail == _email?.toLowerCase()) ||
        (tel != null && tel.isNotEmpty && tel == _phone);
  }

  /// MOCK mode can carry the role from the login screen so verify echoes it.
  // ignore: use_setters_to_change_properties
  void setRole(String role) => _role = role;

  @override
  Future<String?> refresh() async => 'mock-payer-token';

  @override
  Future<void> logout() async {}
}
