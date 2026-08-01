import 'dart:async';

import '../../../core/api/api_client.dart';
import '../../../core/error/failure.dart';
import '../../../core/error/failure_mapper.dart';
import '../../../core/referral/pending_referral_store.dart';
import '../../../core/session/session_repository.dart';
import '../domain/consent_repository.dart';

class ConsentRepositoryImpl implements ConsentRepository {
  ConsentRepositoryImpl(this._api, this._session, [this._pendingReferral]);

  final ApiClient _api;
  final SessionRepository _session;

  /// Optional — absent under the plugin-free widget-test graph (guarded in DI),
  /// where referral attribution is simply inert.
  final PendingReferralStore? _pendingReferral;

  @override
  Future<void> acceptConsent({required List<String> purposes}) async {
    // `POST /consent/accept` is now WORKER-AUTHED and takes the subject from the
    // session, never from the body — consent is the DPDP gate (invariant #6) and
    // a body worker_id on an unguarded route made it forgeable for any worker.
    // So the BEARER is what this call needs; there is no id to send.
    final String? token = _session.sessionToken;
    // Should never happen after login; fail closed rather than call unauthed.
    if (token == null || token.isEmpty) throw const UnauthorizedFailure();
    try {
      await _api.acceptConsent(authToken: token, purposes: purposes);
    } catch (error) {
      throw mapError(error);
    }
    // Consent is now confirmed accepted server-side. Fire a best-effort referral
    // attribution for any pending `/i/<code>` deep-link code — FIRE-AND-FORGET
    // (unawaited) so it NEVER blocks or fails onboarding. Idempotent +
    // consent-gated + no-oracle server-side.
    unawaited(_attributePendingReferral());
  }

  /// Consumes a pending referral code (captured from a deep link) exactly once
  /// and posts it to the consent-gated `/referrals/attribute` route. Best-effort:
  /// swallows any error so a failed side-signal never surfaces to the worker.
  Future<void> _attributePendingReferral() async {
    final PendingReferralStore? store = _pendingReferral;
    if (store == null) return;
    // Reuse the session bearer every worker-scoped call sends (WorkerAuthGuard
    // takes the invited worker from the token, never the body). No token → leave
    // the code for a later attempt rather than consuming it unsent.
    final String? token = _session.sessionToken;
    if (token == null || token.isEmpty) return;
    try {
      final String? code = await store.take(); // reads + clears — consumed once
      if (code == null) return;
      await _api.attributeReferral(authToken: token, code: code);
    } catch (_) {
      // Best-effort side-signal — never surface to onboarding. PII-free: the
      // opaque code is never logged.
    }
  }
}
