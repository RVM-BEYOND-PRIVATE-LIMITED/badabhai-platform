import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';

/// What the worker chose in the photo sheet.
enum PhotoAction { camera, gallery, remove }

/// ADR-0032 — the ONE photo flow, shared by every entry point.
///
/// There is exactly ONE photo per worker, so there is exactly one flow to change
/// it: sheet → pick → resize on-device → hand the bytes back. Extracted from the
/// resume-edit screen so the Profile tab drives the SAME code rather than a
/// second copy that could drift (different picker caps, a different sheet, a
/// missing re-entrancy guard).
///
/// It deliberately does NOT own the upload/remove call or the busy state: the
/// two entry points report progress and errors through their own cubits, and
/// binding this to one of them is what would force the other to grow a private
/// copy. Callers pass [onUpload] / [onRemove]; everything up to the bytes is
/// shared.
///
/// PRIVACY: the picked image is resized + re-encoded ON DEVICE before any byte
/// leaves the phone (ADR-0032 §6). The bytes are handed straight to the caller —
/// never logged, never written to disk by this helper.
Future<void> runPhotoFlow(
  BuildContext context, {
  required bool hasPhoto,
  required void Function(Uint8List bytes) onUpload,
  required VoidCallback onRemove,
}) async {
  final PhotoAction? action = await showPhotoPickerSheet(
    context,
    hasPhoto: hasPhoto,
  );
  if (!context.mounted || action == null) return;

  if (action == PhotoAction.remove) {
    onRemove();
    return;
  }

  final Uint8List? bytes = await pickPhotoBytes(action);
  if (!context.mounted || bytes == null) return; // cancelled / screen gone
  onUpload(bytes);
}

/// The camera / gallery / remove sheet. Returns null when dismissed.
///
/// "Photo hatayein" appears only when a photo actually exists — offering to
/// remove nothing is a dead option.
Future<PhotoAction?> showPhotoPickerSheet(
  BuildContext context, {
  required bool hasPhoto,
}) {
  return showModalBottomSheet<PhotoAction>(
    context: context,
    builder: (BuildContext sheetContext) => SafeArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          ListTile(
            leading: const Icon(Icons.photo_camera_outlined),
            title: const Text('Photo khichein'),
            onTap: () => Navigator.of(sheetContext).pop(PhotoAction.camera),
          ),
          ListTile(
            leading: const Icon(Icons.photo_library_outlined),
            title: const Text('Gallery se chunein'),
            onTap: () => Navigator.of(sheetContext).pop(PhotoAction.gallery),
          ),
          if (hasPhoto)
            ListTile(
              leading: const Icon(Icons.delete_outline),
              title: const Text('Photo hatayein'),
              onTap: () => Navigator.of(sheetContext).pop(PhotoAction.remove),
            ),
        ],
      ),
    ),
  );
}

/// Picks an image and returns its resized JPEG bytes, or null when the worker
/// cancelled or the picker itself failed.
///
/// The picker caps are load-bearing, not cosmetic: the resize + JPEG re-encode
/// happens BEFORE any byte leaves the device (ADR-0032 §6) and keeps the upload
/// inside the server's 2MB cap and the PDF embed small.
///
/// A picker failure (no camera, OS denial) returns null and surfaces NOTHING:
/// it is not the worker's fault and not worth a scary error — the row is still
/// there to retry.
Future<Uint8List?> pickPhotoBytes(PhotoAction action) async {
  assert(action != PhotoAction.remove, 'remove has no image to pick');
  final XFile? picked;
  try {
    picked = await ImagePicker().pickImage(
      source: action == PhotoAction.camera
          ? ImageSource.camera
          : ImageSource.gallery,
      maxWidth: 1024,
      maxHeight: 1024,
      imageQuality: 85,
      // Data minimization, honestly stated (bb-security-review L-1): on iOS this
      // skips full metadata; on Android the resize re-encode strips GPS lat/long
      // but the plugin copies back a few coarse EXIF tags (timestamps/orientation).
      // Server-side strip at confirm is the hardening follow-up (TD71 family).
      requestFullMetadata: false,
    );
  } catch (_) {
    return null;
  }
  if (picked == null) return null;
  return picked.readAsBytes();
}
