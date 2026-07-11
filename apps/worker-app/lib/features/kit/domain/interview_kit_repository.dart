import 'interview_kit.dart';

/// Interview-kit boundary. Lists the wired kits and loads a single per-trade
/// prep pack. Implementations throw a [Failure] on error.
///
/// All three legs are backed by REAL, PUBLIC, PII-free routes: [listKits] →
/// GET /interview-kits, [kit] → GET /interview-kits/:tradeKey (a prep pack —
/// overview + question lists + checklist + documents, NO model answers), and
/// [downloadUrl] → GET /interview-kit/:tradeKey/download.
abstract interface class InterviewKitRepository {
  Future<List<KitListItem>> listKits();
  Future<InterviewKit> kit(String tradeKey);

  /// Fetches a short-lived SIGNED url to the trade's interview-kit PDF
  /// (GET /interview-kit/:tradeKey/download — PUBLIC, PII-free). Throws a
  /// [Failure] on error. PRIVACY: the returned url embeds a token — callers
  /// launch it immediately and never log it.
  Future<String> downloadUrl(String tradeKey);
}
