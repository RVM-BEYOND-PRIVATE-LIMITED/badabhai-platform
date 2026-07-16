import 'dart:async';
import 'dart:convert' show ascii;
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;

import '../error/failure.dart';
import '../error/failure_reason.dart';

/// Hard ceiling on the in-app PDF byte download (the signed-url FETCH — the
/// JSON mint before it already has [ApiClient]'s own 15s bound). Generous for a
/// 2G link pulling a few-hundred-KB PDF, yet bounded so a dead-but-open socket
/// can't spin the button forever; hitting it surfaces the honest
/// [NetworkFailure] copy, never an infinite spinner.
const Duration kPdfDownloadTimeout = Duration(seconds: 60);

// Worker-facing copy, exported so tests assert the exact honest lines.
const String kDownloadStartedNotice = 'Download shuru ho gaya…';
const String kDownloadCompleteNotice =
    'Download complete — Downloads folder mein hai';
const String kDownloadCompleteFallbackNotice =
    'Download complete — file app ke Download folder mein hai';
const String kDownloadOpenActionLabel = 'Kholein';
const String kDownloadGenericFailureNotice =
    'Download nahi ho paya. Dobara koshish karein.';
const String kDownloadNoLinkNotice =
    'PDF link abhi nahi mil paya. Dobara koshish karein.';
const String kDownloadSaveFailureNotice =
    'File save nahi ho payi. Phone ki storage check karke dobara try karein.';
const String kDownloadNoViewerNotice =
    'PDF kholne wala app nahi mila. Ek PDF viewer install karke dobara try karein.';

/// Where a finished download landed, as reported by the platform save.
/// [location] is an OPAQUE local handle for re-opening only — a `content://`
/// MediaStore uri on Android 10+, an absolute app-external file path below.
/// It carries NO signed-url token; it is held in memory for the SnackBar's
/// "Kholein" action and never persisted.
class SavedPdf {
  const SavedPdf({
    required this.location,
    required this.displayName,
    required this.inPublicDownloads,
  });

  final String location;

  /// The final file name AFTER duplicate handling ("name (1).pdf").
  final String displayName;

  /// True when the file landed in the device's PUBLIC Downloads collection
  /// (API 29+ MediaStore); false for the pre-29 app-external fallback. The
  /// success copy keys off this so it stays honest about where the file is.
  final bool inPublicDownloads;
}

/// Saves an already-downloaded TEMP FILE into the device's Downloads. A seam so
/// tests fake the platform side; production uses [MediaStorePdfSaver].
abstract class PdfSaver {
  Future<SavedPdf> save({required String tempPath, required String fileName});
}

/// Opens an already-SAVED local PDF (never a remote url) in the device viewer.
abstract class SavedPdfOpener {
  /// Returns false when no installed app can display a PDF.
  Future<bool> open(String location);
}

/// The single channel to the Android side (MainActivity.kt). PRIVACY: both
/// methods deal ONLY in local files — the signed url never crosses it.
const MethodChannel _downloadsChannel =
    MethodChannel('badabhai.workerapp/downloads');

/// Production [PdfSaver]: MediaStore Downloads insert on API 29+ (no storage
/// permission; the system de-duplicates names), app-external Download dir with
/// an explicit "(1)" dedup below (avoids legacy WRITE_EXTERNAL_STORAGE).
class MediaStorePdfSaver implements PdfSaver {
  const MediaStorePdfSaver();

  @override
  Future<SavedPdf> save({
    required String tempPath,
    required String fileName,
  }) async {
    final Map<dynamic, dynamic>? out = await _downloadsChannel
        .invokeMethod<Map<dynamic, dynamic>>('saveToDownloads', <String, String>{
      'tempPath': tempPath,
      'fileName': fileName,
      'mimeType': 'application/pdf',
    });
    final String? location = out?['location'] as String?;
    if (location == null || location.isEmpty) {
      throw StateError('save returned no location');
    }
    return SavedPdf(
      location: location,
      displayName: (out?['displayName'] as String?) ?? fileName,
      inPublicDownloads: out?['public'] == true,
    );
  }
}

/// Production [SavedPdfOpener]: ACTION_VIEW on the LOCAL file via the channel.
class ViewIntentPdfOpener implements SavedPdfOpener {
  const ViewIntentPdfOpener();

  @override
  Future<bool> open(String location) async {
    try {
      return await _downloadsChannel.invokeMethod<bool>(
            'openSavedFile',
            <String, String>{'location': location},
          ) ??
          false;
    } on PlatformException {
      return false;
    } on MissingPluginException {
      return false;
    }
  }
}

/// Resolves a short-lived SIGNED PDF url via [resolve] and downloads it IN-APP
/// into the device's Downloads — the worker stays on the SAME screen the whole
/// time. Shared by the resume and interview-kit download actions.
///
/// Flow: an immediate "Download shuru ho gaya…" SnackBar → fetch the bytes over
/// package:http, streaming to a temp file in the app cache → hand the LOCAL
/// temp file to [saver] (MediaStore) → "Download complete" SnackBar with a
/// "Kholein" action that opens the SAVED LOCAL file via [opener].
///
/// On failure it shows a SnackBar stating the ACTUAL reason (never a blank
/// generic line): a typed [Failure] thrown by [resolve] (server/network/401/
/// 409-not-rendered/…) shows that failure's honest copy; a non-200 on the byte
/// fetch shows the server-error copy; a timeout/dead socket shows the
/// [NetworkFailure] copy; a platform save error shows the storage copy.
/// [resolve] should let its [Failure] propagate (do NOT swallow it to null).
///
/// PRIVACY (CLAUDE.md §2): the signed url embeds a single-use token. It is held
/// in memory only and fetched IN-APP — NEVER logged, persisted, shown, or
/// handed to another app (a browser or Android DownloadManager would retain it
/// in history/its DB). Only the downloaded LOCAL file — the worker's own
/// document, saved at their explicit request — leaves the app boundary.
///
/// MOCK MODE: a `mock://` url (the [MockApiClient] sentinel) cannot be fetched
/// — a small placeholder PDF is written instead so the flow stays walkable
/// offline, still ending in a real file in Downloads.
///
/// [client], [saver], [opener], and [timeout] are injectable ONLY as test
/// seams; production callers pass just [resolve] and [fileName]. Callers own
/// the button's busy/disabled state while this future runs (double-tap →
/// double files).
Future<void> downloadSignedPdf(
  BuildContext context, {
  required Future<String?> Function() resolve,
  required String fileName,
  http.Client? client,
  PdfSaver saver = const MediaStorePdfSaver(),
  SavedPdfOpener opener = const ViewIntentPdfOpener(),
  Duration timeout = kPdfDownloadTimeout,
}) async {
  // Capture the messenger before the async gaps so we never touch `context`
  // after an await (use_build_context_synchronously).
  final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);

  messenger
    ..clearSnackBars()
    ..showSnackBar(const SnackBar(content: Text(kDownloadStartedNotice)));

  String? url;
  String? reason; // the actual failure reason to surface, or null on success

  try {
    url = await resolve();
  } on Failure catch (f) {
    // The typed cause (network / server 5xx / 401 / PDF-not-rendered / …).
    reason = failureReason(f).reason;
  } catch (_) {
    reason = kDownloadGenericFailureNotice;
  }

  Uri? uri;
  if (reason == null) {
    uri = (url == null || url.isEmpty) ? null : Uri.tryParse(url);
    if (uri == null) {
      // Fetched, but no usable url came back.
      reason = kDownloadNoLinkNotice;
    }
  }

  SavedPdf? saved;
  if (reason == null) {
    final File tempFile = File(
      '${Directory.systemTemp.path}${Platform.pathSeparator}'
      'bb-download-${DateTime.now().microsecondsSinceEpoch}.pdf',
    );
    final http.Client httpClient = client ?? http.Client();
    try {
      if (uri!.scheme == 'mock') {
        // MockApiClient sentinel — nothing to fetch; keep the flow walkable.
        tempFile.writeAsBytesSync(buildPlaceholderPdfBytes(), flush: true);
      } else {
        await _fetchToFile(httpClient, uri, tempFile).timeout(timeout);
      }
      try {
        saved = await saver.save(tempPath: tempFile.path, fileName: fileName);
      } catch (_) {
        reason = kDownloadSaveFailureNotice;
      }
    } on Failure catch (f) {
      reason = failureReason(f).reason;
    } on TimeoutException {
      reason = failureReason(const NetworkFailure()).reason;
    } on http.ClientException {
      reason = failureReason(const NetworkFailure()).reason;
    } on SocketException {
      reason = failureReason(const NetworkFailure()).reason;
    } catch (_) {
      reason = kDownloadGenericFailureNotice;
    } finally {
      if (client == null) httpClient.close();
      // Sync cleanup on purpose: it can't be starved, and a delete that loses a
      // race with a still-draining sink (timeout mid-stream) is harmless — the
      // orphan sits in the purgeable app cache and never reaches Downloads.
      try {
        if (tempFile.existsSync()) tempFile.deleteSync();
      } catch (_) {
        // Best-effort cache cleanup only.
      }
    }
  }

  if (reason != null || saved == null) {
    messenger
      ..clearSnackBars()
      ..showSnackBar(SnackBar(content: Text(reason ?? kDownloadGenericFailureNotice)));
    return;
  }

  final SavedPdf file = saved;
  messenger
    ..clearSnackBars()
    ..showSnackBar(
      SnackBar(
        content: Text(
          file.inPublicDownloads
              ? kDownloadCompleteNotice
              : kDownloadCompleteFallbackNotice,
        ),
        duration: const Duration(seconds: 6),
        action: SnackBarAction(
          label: kDownloadOpenActionLabel,
          onPressed: () async {
            // Opens the SAVED LOCAL file only — no token, safe to hand out.
            final bool opened = await opener.open(file.location);
            if (!opened) {
              messenger
                ..clearSnackBars()
                ..showSnackBar(
                  const SnackBar(content: Text(kDownloadNoViewerNotice)),
                );
            }
          },
        ),
      ),
    );
}

/// Streams the signed url's bytes into [tempFile]. The url lives ONLY in [uri]
/// (memory); nothing here logs it, and only LOCAL paths leave this function.
/// Non-200 → typed [ServerFailure] so the honest status reaches the worker.
Future<void> _fetchToFile(http.Client client, Uri uri, File tempFile) async {
  final http.StreamedResponse res =
      await client.send(http.Request('GET', uri));
  if (res.statusCode != 200) {
    throw ServerFailure(res.statusCode);
  }
  final IOSink sink = tempFile.openWrite();
  try {
    await sink.addStream(res.stream);
    await sink.flush();
  } finally {
    await sink.close();
  }
}

/// A minimal one-page PDF ("BadaBhai sample PDF") assembled with correct xref
/// offsets — MOCK MODE ONLY. MockApiClient's canned `mock://` url points
/// nowhere, so the download flow saves these bytes instead and the whole
/// journey stays walkable offline, ending in a real (tiny) PDF. PII-free.
@visibleForTesting
Uint8List buildPlaceholderPdfBytes() {
  const String content =
      'BT /F1 18 Tf 72 770 Td (BadaBhai sample PDF - mock download) Tj ET';
  final List<String> objects = <String>[
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] '
        '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    '<< /Length ${content.length} >>\nstream\n$content\nendstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  // All-ASCII by construction, so StringBuffer.length == byte offset.
  final StringBuffer buf = StringBuffer('%PDF-1.4\n');
  final List<int> offsets = <int>[];
  for (int i = 0; i < objects.length; i++) {
    offsets.add(buf.length);
    buf.write('${i + 1} 0 obj\n${objects[i]}\nendobj\n');
  }
  final int xrefOffset = buf.length;
  buf
    ..write('xref\n0 ${objects.length + 1}\n')
    ..write('0000000000 65535 f \n');
  for (final int offset in offsets) {
    buf.write('${offset.toString().padLeft(10, '0')} 00000 n \n');
  }
  buf
    ..write('trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n')
    ..write('startxref\n$xrefOffset\n%%EOF\n');
  return Uint8List.fromList(ascii.encode(buf.toString()));
}
