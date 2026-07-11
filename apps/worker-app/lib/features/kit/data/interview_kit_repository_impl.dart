import '../../../core/api/api_client.dart';
import '../../../core/error/failure_mapper.dart';
import '../domain/interview_kit.dart';
import '../domain/interview_kit_repository.dart';

/// Live interview-kit source — all three legs go through [ApiClient] to the real
/// PUBLIC, PII-free interview-kit routes:
///   * [listKits]     → GET /interview-kits           (the wired trade list)
///   * [kit]          → GET /interview-kits/:tradeKey  (the per-trade prep pack)
///   * [downloadUrl]  → GET /interview-kit/:tradeKey/download (signed PDF url)
///
/// The kit content is per-TRADE and carries no worker PII. A wrong/missing trade
/// (404) or rate-limit (429) is mapped to a typed [Failure] so the screen shows
/// the real reason. `tradeKey` is a lowercase slug sourced from the live list
/// selection — never hardcoded and never derived from a jobId.
class InterviewKitRepositoryImpl implements InterviewKitRepository {
  InterviewKitRepositoryImpl(this._api);

  final ApiClient _api;

  @override
  Future<List<KitListItem>> listKits() async {
    try {
      final List<InterviewKitListItem> kits = await _api.getInterviewKits();
      return kits
          .map((InterviewKitListItem k) => KitListItem(
                tradeKey: k.tradeKey,
                title: k.displayName,
                // The list route carries no per-trade counts; keep a stable,
                // honest subtitle describing what the kit contains.
                subtitle: 'Common sawaal · checklist · documents',
              ))
          .toList();
    } catch (error) {
      throw mapError(error);
    }
  }

  @override
  Future<InterviewKit> kit(String tradeKey) async {
    try {
      final InterviewKitContentDto c = await _api.getInterviewKit(tradeKey);
      return InterviewKit(
        tradeKey: c.tradeKey,
        title: c.displayName,
        overview: c.overview,
        commonQuestions: c.commonQuestions,
        practicalQuestions: c.practicalQuestions,
        safetyQuestions: c.safetyQuestions,
        drawingMeasurementQuestions: c.drawingMeasurementQuestions,
        skillChecklist: c.skillChecklist,
        reviseBefore: c.reviseBefore,
        documentsToCarry: c.documentsToCarry,
        commonMistakes: c.commonMistakes,
        hinglishNote: c.hinglishNote,
      );
    } catch (error) {
      throw mapError(error);
    }
  }

  @override
  Future<String> downloadUrl(String tradeKey) async {
    try {
      final InterviewKitDownload dl = await _api.downloadInterviewKit(tradeKey);
      return dl.url;
    } catch (error) {
      throw mapError(error);
    }
  }
}
