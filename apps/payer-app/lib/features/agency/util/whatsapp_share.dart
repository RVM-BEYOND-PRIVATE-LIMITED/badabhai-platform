import 'package:flutter/foundation.dart';
import 'package:url_launcher/url_launcher.dart';

/// The WhatsApp share hand-off for the agency's referral links.
///
/// WHY A DEEP LINK AND NOT A SHARE SHEET: an agent sharing an invite is almost
/// always sending it to one worker on WhatsApp. The share sheet makes that a
/// two-step choice every single time; `wa.me` lands directly on WhatsApp's
/// contact picker with the message already written. (The payer app has no
/// `share_plus` dependency at all, so the sheet was never an option here.)

/// Opens a URL in an external app. Overridable so widget tests can assert WHERE
/// a link went without a platform channel — `launchUrl` throws
/// MissingPluginException under `flutter test`. Mirrors the existing
/// `ExternalUrlLauncher` seam in `jobs_screen.dart`.
typedef WhatsAppLauncher = Future<bool> Function(Uri url);

/// Production launcher: hand the url to WhatsApp (or the browser, which then
/// offers to open WhatsApp) — never an in-app webview.
Future<bool> defaultWhatsAppLauncher(Uri url) =>
    launchUrl(url, mode: LaunchMode.externalApplication);

/// The seam the WhatsApp share leaves through. Production must always leave
/// this as [defaultWhatsAppLauncher].
@visibleForTesting
WhatsAppLauncher whatsAppLauncher = defaultWhatsAppLauncher;

/// Builds `https://wa.me/?text=<urlencoded>`.
///
/// NO PHONE NUMBER in the path — that would open a chat with that specific
/// number. Omitting it opens the CONTACT PICKER, which is what "share this
/// invite" means: the agent picks the recipient.
///
/// The `https://` form rather than `whatsapp://`: the https link degrades to a
/// web page that offers to open WhatsApp when the app is absent, whereas the
/// custom scheme simply fails to resolve. One URL, no dead end.
///
/// PII: [text] must contain only the opaque invite link/code and our own copy.
/// The agency never has a worker's phone or name at mint time — there is no
/// recipient field on any invite endpoint — so there is nothing here to leak.
Uri whatsAppShareUri(String text) =>
    Uri.parse('https://wa.me/?text=${Uri.encodeComponent(text)}');

/// The message wrapped around a shared invite link.
///
/// Deliberately short: it is pre-filled into someone's WhatsApp compose box and
/// they will edit it. A paragraph gets deleted; a line gets sent.
String inviteShareText(String url) =>
    'Join BadaBhai and find factory jobs — no test, just a conversation. $url';

/// Opens WhatsApp with [text] pre-filled. Returns false when nothing could
/// handle it, so the caller can stay honest instead of showing a success toast
/// over a WhatsApp that never opened.
Future<bool> shareOnWhatsApp(String text) async {
  try {
    return await whatsAppLauncher(whatsAppShareUri(text));
  } catch (_) {
    // `launchUrl` both returns false and throws depending on the platform
    // channel's mood; the caller only cares that it did not open.
    return false;
  }
}
