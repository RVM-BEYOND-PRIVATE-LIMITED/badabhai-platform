import 'dart:typed_data';

/// The upload leg for ONE feedback image (mint a signed slot → PUT the JPEG
/// bytes → return the server-owned `storage_path`).
///
/// Split behind an interface exactly like [PhotoUploader]/[VoiceStorageUploader]
/// so mock mode never touches the network. The caller uploads best-effort and
/// SWALLOWS a per-image failure — the worker's TEXT feedback must send even when
/// every image drops (a mint 404/503, a PUT failure). A thrown error therefore
/// means "this one image did not upload", never "the feedback failed".
abstract class FeedbackAttachmentUploader {
  /// Mints a slot, PUTs [bytes] to it, and returns the `storage_path` to attach
  /// to the submission. Throws on any failure (mint 404/503, PUT non-2xx / timeout)
  /// — the caller drops that image and still submits the text.
  Future<String> upload(Uint8List bytes);
}
