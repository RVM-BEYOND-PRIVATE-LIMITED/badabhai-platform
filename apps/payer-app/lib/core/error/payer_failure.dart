import 'dart:async' show TimeoutException;
import 'dart:io' show SocketException;

import 'package:flutter/material.dart' show IconData, Icons;
import 'package:http/http.dart' as http;

import '../data/models.dart' show PayerApiException;

/// The KIND of a failed payer API load, derived from the error a data call threw.
///
/// Every screen shows copy that names the REAL problem instead of one flat
/// "couldn't load": a worker on a dead link, a slow server, a 5xx, and an expired
/// session are four different situations with four different next steps, and
/// telling them apart is the difference between a user who retries and one who
/// gives up (or reinstalls) thinking the app is broken.
enum PayerFailureKind {
  /// No usable connection / the host was unreachable (SocketException, most
  /// http.ClientException). Next step: check the connection.
  network,

  /// The request was sent but the server did not answer inside [kRequestTimeout].
  /// Next step: try again (a slow link or a cold server, not a dead one).
  timeout,

  /// The server answered with a 5xx — the fault is server-side, retrying may work.
  server,

  /// The session is no longer valid (401/403). Next step: log in again. The HTTP
  /// layer already tried a silent refresh; reaching here means that failed.
  session,

  /// The requested resource is gone (404) — not an error to retry, just absent.
  notFound,

  /// Anything we could not classify — a generic, honest fallback.
  unknown,
}

/// A classified, display-ready payer load failure.
///
/// Pure + const so it can live in cubit state and be asserted in tests. Build it
/// with [PayerFailure.from] at the `catch` site; render [message] (and, for the
/// error card heading, [title]); branch UI on [kind] / [isSessionExpired].
class PayerFailure {
  const PayerFailure(this.kind, {this.statusCode});

  /// The HTTP status when the failure came from a server response; null for a
  /// transport failure (never reached / no reply). PII-free.
  final int? statusCode;

  final PayerFailureKind kind;

  /// Maps a caught error to a [PayerFailure]. Handles the two shapes every payer
  /// data call can throw: a [PayerApiException] (built from a non-2xx status) or
  /// a raw transport exception the HTTP client let through (timeout / socket /
  /// client error). Anything else is [PayerFailureKind.unknown] — never a crash.
  factory PayerFailure.from(Object? error) {
    if (error is PayerFailure) return error;
    if (error is PayerApiException) {
      final int s = error.statusCode;
      if (s == 401 || s == 403) {
        return PayerFailure(PayerFailureKind.session, statusCode: s);
      }
      if (s == 404) {
        return PayerFailure(PayerFailureKind.notFound, statusCode: s);
      }
      if (s >= 500) {
        return PayerFailure(PayerFailureKind.server, statusCode: s);
      }
      return PayerFailure(PayerFailureKind.unknown, statusCode: s);
    }
    if (error is TimeoutException) {
      return const PayerFailure(PayerFailureKind.timeout);
    }
    // A dead/blocked socket, or the http client wrapping one — both mean the
    // request never got a usable reply from the host.
    if (error is SocketException || error is http.ClientException) {
      return const PayerFailure(PayerFailureKind.network);
    }
    return const PayerFailure(PayerFailureKind.unknown);
  }

  /// True when the fix is to re-authenticate (the caller can route to Login).
  bool get isSessionExpired => kind == PayerFailureKind.session;

  /// The glyph for the error card — one source of truth so every screen reads the
  /// same visual for the same cause.
  IconData get icon => switch (kind) {
        PayerFailureKind.network => Icons.wifi_off,
        PayerFailureKind.timeout => Icons.hourglass_empty,
        PayerFailureKind.server => Icons.cloud_off,
        PayerFailureKind.session => Icons.lock_outline,
        PayerFailureKind.notFound => Icons.search_off,
        PayerFailureKind.unknown => Icons.error_outline,
      };

  /// A short heading for the error card.
  String get title => switch (kind) {
        PayerFailureKind.network => "Can't reach the server",
        PayerFailureKind.timeout => 'Server is slow to respond',
        PayerFailureKind.server => 'Something went wrong',
        PayerFailureKind.session => 'Session expired',
        PayerFailureKind.notFound => 'Not available',
        PayerFailureKind.unknown => 'Something went wrong',
      };

  /// The user-facing explanation + the next step. Never blames the connection
  /// when the real cause is the server (or vice-versa).
  String get message => switch (kind) {
        PayerFailureKind.network =>
          'Check your internet connection and try again.',
        PayerFailureKind.timeout =>
          'The server took too long to respond. Please try again.',
        PayerFailureKind.server =>
          "This is a problem on our side, not yours. Please try again in a moment.",
        PayerFailureKind.session =>
          'Please log in again to continue.',
        PayerFailureKind.notFound =>
          "This isn't available anymore.",
        PayerFailureKind.unknown =>
          'Something went wrong. Please try again.',
      };

  @override
  String toString() => 'PayerFailure($kind${statusCode == null ? '' : ', $statusCode'})';
}
