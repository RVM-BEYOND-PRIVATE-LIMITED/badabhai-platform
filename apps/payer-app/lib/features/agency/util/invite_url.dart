import '../../../core/config/app_config.dart';

/// Turns a minted invite [link] into an ABSOLUTE share URL suitable for a QR
/// code and a WhatsApp paste. The wire `link` may arrive in three shapes:
///
///  - already absolute — `https://app.badabhai.in/i/CODE` → used verbatim;
///  - scheme-less host — `badabhai.in/i/CODE` (the mock seam) → gets `https://`;
///  - path-only        — `/i/CODE` → resolved against the payer-web origin
///    ([resolvePayerWebUrl]).
///
/// Returns the raw [link] untouched only as a last resort (a path-only link with
/// no resolvable origin) — a QR of that is useless, but it is strictly better
/// than a crash, and in practice the origin has a baked-in default.
String absoluteInviteUrl(String link, {String? webOrigin}) {
  final String raw = link.trim();
  if (raw.isEmpty) return raw;

  // Protocol-relative (`//host/path`) — inherit https.
  if (raw.startsWith('//')) return 'https:$raw';

  final Uri? parsed = Uri.tryParse(raw);
  if (parsed != null && parsed.hasScheme && parsed.host.isNotEmpty) {
    return raw;
  }

  final String? origin = webOrigin ?? resolvePayerWebUrl();

  // Path-only (`/i/CODE`) — needs an origin to be meaningful.
  if (raw.startsWith('/')) {
    if (origin == null) return raw;
    final Uri base = Uri.parse(origin);
    return base.replace(path: raw, query: null, fragment: null).toString();
  }

  // Bare `host/path` (no scheme) — the safe default is https.
  return 'https://$raw';
}
