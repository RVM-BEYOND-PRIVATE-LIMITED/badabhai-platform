import 'dart:async';

import '../../../core/api/api_client.dart';
import '../../../core/error/failure.dart';
import '../../../core/error/failure_mapper.dart';
import '../../../core/referral/pending_referral_store.dart';
import '../../../core/session/session_repository.dart';
import '../domain/consent_repository.dart';
import '../domain/employer_contact.dart';

class ConsentRepositoryImpl implements ConsentRepository {
  ConsentRepositoryImpl(this._api, this._session, [this._pendingReferral]);

  final ApiClient _api;
  final SessionRepository _session;

  /// Optional — absent under the plugin-free widget-test graph (guarded in DI),
  /// where referral attribution is simply inert.
  final PendingReferralStore? _pendingReferral;

  @override
  Future<void> acceptConsent({
    required List<String> purposes,
    required bool age18Plus,
  }) async {
    // `POST /consent/accept` is now WORKER-AUTHED and takes the subject from the
    // session, never from the body — consent is the DPDP gate (invariant #6) and
    // a body worker_id on an unguarded route made it forgeable for any worker.
    // So the BEARER is what this call needs; there is no id to send.
    final String? token = _session.sessionToken;
    // Should never happen after login; fail closed rather than call unauthed.
    if (token == null || token.isEmpty) throw const UnauthorizedFailure();
    try {
      await _api.acceptConsent(
        authToken: token,
        purposes: purposes,
        age18Plus: age18Plus,
        // #2753 item 13 — certify the version the SERVER serves, not a copy
        // compiled into the app. Fall back to `kConsentVersion` only when the
        // notice read fails (an older server), exactly as before.
        consentVersion: await _servedNoticeVersion(token),
      );
    } catch (error) {
      throw mapError(error);
    }
    // Consent is now confirmed accepted server-side. Fire a best-effort referral
    // attribution for any pending `/i/<code>` deep-link code — FIRE-AND-FORGET
    // (unawaited) so it NEVER blocks or fails onboarding. Idempotent +
    // consent-gated + no-oracle server-side.
    unawaited(_attributePendingReferral());
  }

  @override
  Future<void> withdrawConsent() async {
    // `POST /consent/withdraw` is WORKER-AUTHED and takes the subject from the
    // session token, never a body — same rule as accept. So the BEARER is all
    // this call needs. Fail closed rather than call unauthed.
    final String? token = _session.sessionToken;
    if (token == null || token.isEmpty) throw const UnauthorizedFailure();
    try {
      await _api.withdrawConsent(authToken: token);
    } catch (error) {
      throw mapError(error);
    }
    // On success the server has revoked EVERY session (consent.service.ts) — the
    // hard-logout is the cubit's job (it flips AuthStatus → the router bounces to
    // phone login), not the repository's.
  }

  @override
  Future<EmployerContactInfo> employerContactState() async {
    final String? token = _session.sessionToken;
    if (token == null || token.isEmpty) throw const UnauthorizedFailure();
    try {
      return EmployerContactInfo.fromDto(
        await _api.getConsentState(authToken: token),
      );
    } catch (error) {
      throw mapError(error);
    }
  }

  @override
  Future<void> withdrawEmployerContact() async {
    // Same rule as accept/withdraw: the bearer is the subject. NOT `withdrawConsent`
    // — this keeps profiling/resume/voice and does not revoke sessions.
    final String? token = _session.sessionToken;
    if (token == null || token.isEmpty) throw const UnauthorizedFailure();
    try {
      await _api.withdrawEmployerContact(authToken: token);
    } catch (error) {
      throw mapError(error);
    }
  }

  @override
  Future<void> grantEmployerContact() async {
    // The bearer is the subject; the version is the notice the app just
    // showed. It is read from the API so a server-side notice bump does not
    // leave the grant certifying a stale compiled version.
    final String? token = _session.sessionToken;
    if (token == null || token.isEmpty) throw const UnauthorizedFailure();
    try {
      await _api.grantEmployerContact(
        authToken: token,
        consentVersion: await _servedNoticeVersion(token),
      );
    } catch (error) {
      throw mapError(error);
    }
  }

  @override
  Future<ConsentNoticeDto> consentNotice() async {
    final String? token = _session.sessionToken;
    if (token == null || token.isEmpty) throw const UnauthorizedFailure();
    try {
      return await _api.getConsentNotice(authToken: token);
    } catch (error) {
      throw mapError(error);
    }
  }

  /// The server's current notice version, or the compiled `kConsentVersion`
  /// when the notice read fails (an older server has no `/consent/notice`).
  /// Never throws: the write that follows certifies a version the server either
  /// just served or the one this build is known to have shown.
  Future<String> _servedNoticeVersion(String token) async {
    try {
      final String version =
          (await _api.getConsentNotice(authToken: token)).version;
      if (version.isNotEmpty) return version;
    } catch (_) {
      // Older server / transient read failure — keep the compiled version.
    }
    return kConsentVersion;
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
      // reads + clears — consumed once; carries the install-source leg (if any)
      // captured alongside the code.
      final PendingReferral? pending = await store.takePending();
      if (pending == null) return;
      await _api.attributeReferral(
        authToken: token,
        code: pending.code,
        source: pending.source,
      );
    } catch (_) {
      // Best-effort side-signal — never surface to onboarding. PII-free: the
      // opaque code + leg are never logged.
    }
  }
}
