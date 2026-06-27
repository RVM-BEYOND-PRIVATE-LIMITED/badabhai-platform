import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

/// Resolves a short-lived SIGNED PDF url via [resolve] and opens it in the
/// device's browser / PDF viewer (an external VIEW intent). Shared by the resume
/// and interview-kit download actions.
///
/// On ANY failure — [resolve] yields null/empty, the url won't parse, or the OS
/// refuses to launch — a single user-safe SnackBar is shown in the worker's
/// voice (no server detail, no url). A stale/expired url simply fails to open
/// and the worker can tap again to re-fetch.
///
/// PRIVACY (CLAUDE.md §2): the signed url embeds a single-use token. It is
/// launched immediately and is NEVER logged, persisted, or shown to the worker.
Future<void> openSignedPdf(
  BuildContext context, {
  required Future<String?> Function() resolve,
}) async {
  // Capture the messenger before the async gaps so we never touch `context`
  // after an await (use_build_context_synchronously).
  final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);

  String? url;
  try {
    url = await resolve();
  } catch (_) {
    url = null;
  }

  final Uri? uri = (url == null || url.isEmpty) ? null : Uri.tryParse(url);
  bool opened = false;
  if (uri != null) {
    try {
      opened = await launchUrl(uri, mode: LaunchMode.externalApplication);
    } catch (_) {
      opened = false;
    }
  }

  if (!opened) {
    messenger
      ..clearSnackBars()
      ..showSnackBar(
        const SnackBar(
          content: Text('PDF abhi nahi khul paya. Dobara koshish karein.'),
        ),
      );
  }
}
