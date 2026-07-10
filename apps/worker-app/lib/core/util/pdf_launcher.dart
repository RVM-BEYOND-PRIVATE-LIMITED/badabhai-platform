import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../error/failure.dart';
import '../error/failure_reason.dart';

/// Resolves a short-lived SIGNED PDF url via [resolve] and opens it in the
/// device's browser / PDF viewer (an external VIEW intent). Shared by the resume
/// and interview-kit download actions.
///
/// On failure it shows a SnackBar stating the ACTUAL reason (never a blank
/// generic line): if [resolve] throws a typed [Failure] (server/network/401/…)
/// that failure's honest reason is shown; if it yields null/empty the link
/// couldn't be fetched; if the OS refuses to launch, no PDF-capable app was
/// found. [resolve] should let its [Failure] propagate (do NOT swallow it to
/// null) so the real cause reaches the worker.
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
  String? reason; // the actual failure reason to surface, or null on success

  try {
    url = await resolve();
  } on Failure catch (f) {
    // The typed cause (network / server 5xx / 401 / no-profile / rate-limit).
    reason = failureReason(f).reason;
  } catch (_) {
    reason = 'PDF abhi nahi khul paya. Dobara koshish karein.';
  }

  if (reason == null) {
    final Uri? uri = (url == null || url.isEmpty) ? null : Uri.tryParse(url);
    if (uri == null) {
      // Fetched, but no usable url came back.
      reason = 'PDF link abhi nahi mil paya. Dobara koshish karein.';
    } else {
      bool opened = false;
      try {
        opened = await launchUrl(uri, mode: LaunchMode.externalApplication);
      } catch (_) {
        opened = false;
      }
      if (!opened) {
        // The link is fine; the device has no app to open it.
        reason = 'PDF kholne wala app nahi mila. Ek browser install karke '
            'dobara try karein.';
      }
    }
  }

  if (reason != null) {
    messenger
      ..clearSnackBars()
      ..showSnackBar(SnackBar(content: Text(reason)));
  }
}
