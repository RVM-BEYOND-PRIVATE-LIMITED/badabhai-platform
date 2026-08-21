import 'dart:typed_data';

import 'package:image_picker/image_picker.dart';

import '../domain/feedback_image_picker.dart';

/// REAL [FeedbackImagePicker] over the platform `image_picker`.
///
/// The caps are load-bearing, not cosmetic: the resize + JPEG re-encode happens
/// ON DEVICE before any byte leaves the phone, keeping the upload small on a 2G
/// uplink. Mirrors the profile-photo picker's caps EXCEPT there is NO 1:1 crop —
/// feedback images are free-form (a photo of a broken screen, a payslip), not a
/// face.
///
/// A picker failure (no camera, OS denial) or a read failure returns null and
/// surfaces NOTHING: it is not the worker's fault and not worth a scary error —
/// the add affordance is still there to retry.
class ImagePickerFeedbackImagePicker implements FeedbackImagePicker {
  ImagePickerFeedbackImagePicker([ImagePicker? picker])
      : _picker = picker ?? ImagePicker();

  final ImagePicker _picker;

  @override
  Future<Uint8List?> pick(FeedbackImageSource source) async {
    final XFile? picked;
    try {
      picked = await _picker.pickImage(
        source: source == FeedbackImageSource.camera
            ? ImageSource.camera
            : ImageSource.gallery,
        maxWidth: 1600,
        maxHeight: 1600,
        imageQuality: 80,
        // Data minimization: skip full metadata (the resize re-encode strips
        // most EXIF; server-side strip is the hardening follow-up, TD71 family).
        requestFullMetadata: false,
      );
    } catch (_) {
      return null;
    }
    if (picked == null) return null;
    try {
      return await picked.readAsBytes();
    } catch (_) {
      return null;
    }
  }
}
