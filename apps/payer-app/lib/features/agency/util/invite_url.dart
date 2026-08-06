import '../../../core/config/app_config.dart';

/// Turns a minted invite [link] into an ABSOLUTE share URL suitable for a QR
/// code and a WhatsApp paste. The wire `link` may arrive in three shapes:
///
///  - already absolute — `https://app.badabhai.in/i/CODE` → used verbatim;
///  - scheme-less host — `badabhai.in/i/CODE` (the mock seam) → gets `https://`;
///  - path-only        — `/i/CODE` → resolved against the payer-web origin
///    ([resolvePayerWebUrl]).
///
/// Returns the raw [link] untouched only as a last resort — a path-only link
/// and no resolvable origin, which happens when a build supplies a malformed or
/// plaintext `PAYER_WEB_URL`. A QR of that is useless, but it is strictly better
/// than a crash.
///
/// [configuredWebUrl] is injectable ONLY so the rules can be unit-tested (the
/// dart-define is fixed at compile time), mirroring [resolvePayerApiBaseUrl] and
/// [resolvePayerWebUrl]. Production callers pass nothing, so a test origin is
/// held to exactly the same validation production applies.
String absoluteInviteUrl(String link, {String? configuredWebUrl}) {
  final String raw = link.trim();
  if (raw.isEmpty) return raw;

  // Protocol-relative (`//host/path`) — inherit https.
  if (raw.startsWith('//')) return 'https:$raw';

  final Uri? parsed = Uri.tryParse(raw);
  if (parsed != null && parsed.hasScheme && parsed.host.isNotEmpty) {
    return raw;
  }

  final String? origin = resolvePayerWebUrl(configuredUrl: configuredWebUrl);

  // Path-only (`/i/CODE`) — needs an origin to be meaningful.
  if (raw.startsWith('/')) {
    if (origin == null) return raw;

    // RFC 3986 reference resolution: an absolute-path reference adopts the
    // origin's scheme + authority and DROPS the origin's own path, query and
    // fragment, while keeping any query the reference itself carries.
    //
    // This was `base.replace(path: raw, query: null, fragment: null)`, which
    // reads as "strip them" but did nothing: a null named argument is
    // indistinguishable from an omitted one in Dart, and `Uri.replace` KEEPS
    // any component it is not given. A `PAYER_WEB_URL` carrying a query leaked
    // it into every invite link, QR and WhatsApp message
    // (`…/x?a=1` + `/i/CODE` → `https://…/i/CODE?a=1`). A fragment never got
    // this far: `Uri.isAbsolute` is false when one is present, so
    // [resolvePayerWebUrl] rejects such an origin outright.
    final Uri resolved = Uri.parse(origin).resolve(raw);

    // `resolve` faithfully carries userInfo across. This URL is printed on a
    // poster and pasted into WhatsApp, so credentials in a misconfigured
    // PAYER_WEB_URL must never ride along to a candidate.
    return (resolved.userInfo.isEmpty ? resolved : resolved.replace(userInfo: ''))
        .toString();
  }

  // Bare `host/path` (no scheme) — the safe default is https.
  return 'https://$raw';
}
