import 'dart:async' show TimeoutException;
import 'dart:io' show HandshakeException, SocketException;

import 'package:http/http.dart' as http;

import '../data/models.dart';

/// The ONE catalogue that turns an API error code / HTTP status into human
/// copy (#2690, rule 3). Nothing in the UI renders a raw server message, a
/// status code, an exception string or a stack trace.
///
/// Keys are namespaced so an operation can keep its own honest wording without
/// forking into a second catalogue:
///  - `code:<server code>` wins first (typed refusals like a closed job);
///  - `<context>:<status>` and `<context>:other` then win, so "already on your
///    team" never becomes the generic 409 line;
///  - `status:<status>` is the shared fallback;
///  - `error:generic` is the safe line for an UNKNOWN code or shape.
abstract final class ApiErrorCopy {
  ApiErrorCopy._();

  static const String generic =
      'Something went wrong. Please try again.';
  static const String invalidDetails =
      'Check the details and try again.';
  static const String network =
      'Check your internet connection and try again.';
  static const String timeout =
      'The server took too long to respond. Please try again.';
  static const String server =
      'This is a problem on our side, not yours. Please try again in a moment.';
  static const String session = 'Please log in again to continue.';
  static const String notFound = "This isn't available anymore.";
  static const String busy =
      'Too many tries. Please wait a moment and try again.';
  static const String notPossible =
      'This action is no longer possible. Please refresh and try again.';

  /// Every human line the payer app can say for a failed API call.
  static const Map<String, String> copy = <String, String>{
    // Typed server refusals.
    'code:$kJobEditSetAndClearedCode': kJobEditSetAndClearedMessage,
    'code:$kJobEditNoChangesCode': kJobEditNoChangesMessage,
    'code:$kJobEditClosedCode': kJobEditClosedMessage,
    'code:$kPostingTradeRequiredCode': kPostingTradeRequiredMessage,

    // Shared status fallbacks.
    'status:400': invalidDetails,
    'status:401': session,
    'status:403': session,
    'status:404': notFound,
    'status:408': timeout,
    'status:409': notPossible,
    'status:429': busy,
    'status:500': server,
    'status:502': server,
    'status:503': server,
    'status:504': server,

    // Org / team — each action names its own consequence.
    'org.invite:409': 'Already on your team, or your team is full.',
    'org.invite:503': "Couldn't send the invite email. Try again in a bit.",
    'org.invite:403': 'Only the org owner can invite teammates.',
    'org.invite:other': "Couldn't send the invite right now.",
    'org.invite:network': 'Network error. Check your connection.',
    'org.remove:409': "You can't remove the org owner.",
    'org.remove:403': 'Only the org owner can remove teammates.',
    'org.remove:other': "Couldn't remove them right now.",
    'org.remove:network': 'Network error. Check your connection.',
    'org.accept:404': 'That invite link is invalid or has expired.',
    'org.accept:403': 'This invite was sent to a different email.',
    'org.accept:other': "Couldn't accept the invite right now.",
    'org.accept:network': 'Network error. Check your connection.',
    'org.load:other': 'Could not load your team. Retry in a moment.',

    // Jobs.
    'jobs:network': network,
    'jobs:other': 'Could not update. Please try again.',
    'agency.jobs:404': "This job isn't available.",
    'agency.jobs:network': 'Network error. Check your connection.',
    'agency.jobs:other': 'Could not update. Please try again.',

    // Account.
    'account.save:other':
        'Could not save your changes. Check the details and retry.',
    'account.load:other':
        'Could not load your account. Retry in a moment.',

    // Network / unknown.
    'network:network': network,
    'network:timeout': timeout,
    'error:generic': generic,
  };

  /// The human line for [error]. [context] names the operation (e.g.
  /// `org.invite`) when it has its own wording; [fallback] is used only when
  /// nothing else matches. An unknown code/shape ALWAYS gets a safe line —
  /// never the exception's own `toString()` or a server message.
  static String forError(
    Object? error, {
    String? context,
    String? fallback,
  }) {
    if (error is PayerApiException) {
      final String? code = error.code;
      if (code != null && code.isNotEmpty) {
        final String? byCode = copy['code:$code'];
        if (byCode != null) return byCode;
      }
      if (context != null) {
        final String? byContext = copy['$context:${error.statusCode}'];
        if (byContext != null) return byContext;
        final String? contextOther = copy['$context:other'];
        if (contextOther != null) return contextOther;
      }
      final String? byStatus = copy['status:${error.statusCode}'];
      if (byStatus != null) return byStatus;
      return fallback ?? generic;
    }
    if (error is TimeoutException) {
      return _withContext(context, 'timeout') ?? timeout;
    }
    if (error is SocketException ||
        error is HandshakeException ||
        error is http.ClientException) {
      return _withContext(context, 'network') ?? network;
    }
    return fallback ?? generic;
  }

  static String? _withContext(String? context, String key) {
    if (context == null) return null;
    return copy['$context:$key'];
  }
}
