import '../../../core/api/api_models.dart'
    show CatalogueOptionDto, ExtractedCorrection, QualificationOptionsDto;
import 'extracted_review.dart';

/// Read + correction boundary for the extracted-profile review surface
/// (#1595, §8.4): show what extraction recorded, correct it through the
/// audited POST, confirm the corrected profile.
abstract interface class ExtractedReviewRepository {
  /// The extracted facts from the stores that own them (profile row for
  /// skills/machines/experience, qualifications rows for education +
  /// certificates), plus the correction anchor (profile/session) when the
  /// worker has one.
  Future<ExtractedReview> load();

  /// POST /profile/corrections with 1–5 unique-field entries. Returns the
  /// server counts (applied + lifetime). Throws [ApiException] — the cubit
  /// maps the stable 409 codes (deferral, cap) to honest states.
  Future<({int applied, int correctionCount})> submit(
    List<ExtractedCorrection> corrections,
  );

  /// POST /profile/confirm after correcting (§8.4) — the server confirms
  /// and renders the CORRECTED profile. Returns the server's `next`
  /// destination, or null when the server says nothing.
  Future<String?> confirm();

  /// Credential/council slug→label maps for the education add-form
  /// (`GET /workers/me/qualifications/options`). Optional garnish: a miss
  /// degrades the add-form to stored slugs, never the review.
  Future<QualificationOptionsDto> loadQualificationOptions();

  /// The skill catalogue (`GET /workers/me/skills/options`, #1596) — the only
  /// source of the ids a skills correction sends. Throws a typed [Failure]:
  /// unlike the qualification maps this is NOT garnish (no catalogue, no
  /// skills picker), so the cubit shows the real reason with a retry.
  Future<List<CatalogueOptionDto>> loadSkillOptions();

  /// The machine catalogue (`GET /workers/me/machines/options`) — same rule
  /// as [loadSkillOptions].
  Future<List<CatalogueOptionDto>> loadMachineOptions();
}
