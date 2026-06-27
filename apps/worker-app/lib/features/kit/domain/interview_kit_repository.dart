import 'interview_kit.dart';

/// Interview-kit boundary. Lists the kits available to the worker and loads a
/// single per-trade kit. Implementations throw a [Failure] on error.
///
/// NOTE: [listKits]/[kit] are static curated content with NO backend (there is
/// no list route and no inline-Q&A endpoint) — they stay client-side. Only
/// [downloadUrl] is backed by a real endpoint (GET /interview-kit/:tradeKey/download).
abstract interface class InterviewKitRepository {
  Future<List<KitListItem>> listKits();
  Future<InterviewKit> kit(String tradeKey);

  /// Fetches a short-lived SIGNED url to the trade's interview-kit PDF
  /// (GET /interview-kit/:tradeKey/download — PUBLIC, PII-free). Throws a
  /// [Failure] on error. PRIVACY: the returned url embeds a token — callers
  /// launch it immediately and never log it.
  Future<String> downloadUrl(String tradeKey);
}
