import 'dart:typed_data';

/// ADR-0032 — the worker's profile photo (their OWN app + OWN resume PDF only;
/// the payer surface never sees it). Implementations must treat every signed URL
/// as a bearer credential: fetch on view, hold in memory only, never log or
/// persist it.
abstract class PhotoRepository {
  /// A short-lived signed URL for the worker's current photo, or null when the
  /// worker has none (a 404 is "none", not an error). Throws a typed [Failure]
  /// on real errors (session gone / feature off / transport).
  Future<String?> photoUrl();

  /// Uploads [bytes] (an on-device-resized JPEG) as the worker's photo:
  /// mint signed slot → PUT bytes directly to storage → confirm. Replaces any
  /// existing photo server-side. Throws a typed [Failure] on any step.
  Future<void> uploadPhoto(Uint8List bytes);

  /// Removes the worker's photo (idempotent server-side).
  Future<void> removePhoto();
}

/// The byte-PUT leg of the upload, split behind an interface (exactly like
/// VoiceStorageUploader) so mock mode never touches the network.
abstract class PhotoUploader {
  Future<void> put({required String uploadUrl, required Uint8List bytes});
}
