import 'package:equatable/equatable.dart';

import '../auth/payer_http.dart';
import '../auth/payer_token_store.dart';
import 'models.dart';

/// The payer's own account, from `GET /payer/me`. PII-light: `orgName` + `email`
/// + the last 4 of the phone (never the full number). The token, not this body,
/// identifies the payer.
class PayerMe extends Equatable {
  const PayerMe({
    required this.id,
    required this.role,
    required this.status,
    required this.orgName,
    required this.email,
    required this.phoneLast4,
  });

  final String id;
  final String role;
  final String status;
  final String orgName;
  final String email;
  final String phoneLast4;

  factory PayerMe.fromJson(Map<String, dynamic> json) => PayerMe(
        id: json['id'] as String? ?? '',
        role: json['role'] as String? ?? '',
        status: json['status'] as String? ?? '',
        orgName: json['orgName'] as String? ?? '',
        email: json['email'] as String? ?? '',
        phoneLast4: json['phoneLast4'] as String? ?? '',
      );

  @override
  List<Object?> get props =>
      <Object?>[id, role, status, orgName, email, phoneLast4];
}

/// The Account-screen data seam: `GET /payer/me`, `PATCH /payer/me`, and a
/// best-effort `POST /payer/logout`. Kept OFF the [PayerApiClient] interface (the
/// feed/credits seam carries no `/me`) so it is additive; picked MOCK vs REAL by
/// `createPayerAccountApi` behind `kUseMocks`, mirroring `createPayerApiClient`.
abstract interface class PayerAccountApi {
  /// `GET /payer/me` → the signed-in payer's PII-light account.
  Future<PayerMe> fetchMe();

  /// `PATCH /payer/me` — send ONLY changed fields (strict: ≥1 field, unknown key
  /// → 400). `phone` is E164 in, but the response only ever carries `phoneLast4`.
  Future<PayerMe> updateMe({String? orgName, String? phone});

  /// `POST /payer/logout` (204) — best-effort server-side session end.
  Future<void> logout();
}

/// Account get/update/logout over the real `/payer/*` surface.
class HttpPayerAccountApi implements PayerAccountApi {
  HttpPayerAccountApi(this._http);

  final PayerHttp _http;

  /// `GET /payer/me`.
  @override
  Future<PayerMe> fetchMe() async {
    final PayerResponse res = await _http.send(PayerMethod.get, '/payer/me');
    // A non-2xx must NOT decode into a blank [PayerMe] emitted as "ready" — a
    // 5xx/400 would silently blank the account. Surface it so AccountCubit shows
    // the real error state (mirrors HttpPayerAuthApi.refresh's guard).
    if (!res.isSuccess) throw PayerApiException(res.statusCode);
    return PayerMe.fromJson(res.body);
  }

  /// `PATCH /payer/me {orgName?, phone?}` — only the fields supplied are sent, so
  /// a caller passing exactly what changed keeps the body minimal (unknown keys
  /// / a no-op empty body would be a 400 server-side).
  @override
  Future<PayerMe> updateMe({String? orgName, String? phone}) async {
    final Map<String, dynamic> body = <String, dynamic>{};
    if (orgName != null) body['orgName'] = orgName;
    if (phone != null) body['phone'] = phone;
    final PayerResponse res =
        await _http.send(PayerMethod.patch, '/payer/me', body: body);
    // A rejected PATCH (400 unknown key / no-op, 5xx) must not parse into a
    // blank PayerMe that overwrites the shown account — throw so the caller
    // keeps the prior value and surfaces the error.
    if (!res.isSuccess) throw PayerApiException(res.statusCode);
    return PayerMe.fromJson(res.body);
  }

  /// `POST /payer/logout` (204). Best-effort server-side session end; the caller
  /// still clears the token store regardless of the result.
  @override
  Future<void> logout() async {
    await _http.send(PayerMethod.post, '/payer/logout');
  }
}

/// MOCK `/payer/me` — canned, PII-free account so the Account screen is walkable
/// with no backend. Reads the locked role from [PayerTokenStore] so the mock
/// identity matches the role chosen at login; `phoneLast4` is a masked stub and
/// `updateMe` echoes the edited fields back (never storing a full phone).
class MockPayerAccountApi implements PayerAccountApi {
  MockPayerAccountApi(this._tokens);

  final PayerTokenStore _tokens;

  PayerMe _me = const PayerMe(
    id: 'mock-payer-id',
    role: 'employer',
    status: 'active',
    orgName: 'Kalyani Industries',
    email: 'demo@badabhai.in',
    phoneLast4: '3210',
  );

  @override
  Future<PayerMe> fetchMe() async {
    final bool agent = _tokens.role == 'agent';
    _me = PayerMe(
      id: _me.id,
      role: agent ? 'agent' : 'employer',
      status: 'active',
      orgName: agent ? 'Apex Staffing' : 'Kalyani Industries',
      email: 'demo@badabhai.in',
      phoneLast4: _me.phoneLast4,
    );
    return _me;
  }

  @override
  Future<PayerMe> updateMe({String? orgName, String? phone}) async {
    _me = PayerMe(
      id: _me.id,
      role: _me.role,
      status: _me.status,
      orgName: orgName ?? _me.orgName,
      email: _me.email,
      // A full phone is never stored — only the masked last 4 is kept.
      phoneLast4:
          (phone != null && phone.length >= 4) ? phone.substring(phone.length - 4) : _me.phoneLast4,
    );
    return _me;
  }

  @override
  Future<void> logout() async {}
}
