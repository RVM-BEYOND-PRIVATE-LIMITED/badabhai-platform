import 'dart:typed_data';

/// Where a feedback image comes from — the two options the source-chooser sheet
/// offers. Kept plugin-free (no `image_picker` import) so the domain seam does
/// not depend on the platform package.
enum FeedbackImageSource { camera, gallery }

/// Picks ONE image from [FeedbackImageSource] and returns the on-device-resized
/// JPEG bytes, or null when the worker cancelled or the picker failed (no camera,
/// OS denial) — a picker failure is not the worker's fault and surfaces nothing.
///
/// Behind an interface (like the voice recorder) so a widget test never touches
/// the platform `image_picker` channel. Feedback images are FREE-FORM: unlike the
/// profile photo they are NOT square-cropped.
abstract class FeedbackImagePicker {
  Future<Uint8List?> pick(FeedbackImageSource source);
}
