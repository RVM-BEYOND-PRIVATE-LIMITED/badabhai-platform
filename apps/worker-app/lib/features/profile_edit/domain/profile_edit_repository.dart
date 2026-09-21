import '../../../core/api/api_client.dart'
    show
        LanguageAbilityDto,
        MyLanguagesDto,
        MyOccupationsDto,
        MyPortfolioDto,
        MyQualificationsDto,
        MyWhatsappDto,
        PortfolioItemDto,
        PortfolioUploadTicket,
        WorkPrefOptionsDto;
import 'profile_edit_models.dart';

/// Data boundary for the Layer A profile surfaces (ADR-0042 D9, issue #1545):
/// WhatsApp, richer languages, extended work preferences, trainings + licence,
/// secondary occupations and the portfolio.
///
/// Every write is a REPLACE-ALL PUT (except the work-preferences PATCH, which is
/// the existing tri-state body), so the repository stays a thin pass-through —
/// the tri-state shaping and touched tracking live in the cubit, deliberately,
/// so a partial save cannot wipe a half the worker never opened.
abstract interface class ProfileEditRepository {
  Future<MyWhatsappDto> loadWhatsapp();
  Future<void> saveWhatsapp(String? whatsapp);

  Future<MyLanguagesDto> loadLanguages();
  Future<void> saveLanguages(List<LanguageAbilityDto> languages);

  Future<MyOccupationsDto> loadOccupations();
  Future<void> saveOccupations(List<String> roleIds);

  Future<MyQualificationsDto> loadQualifications();

  /// Tri-state per list: a key present REPLACES that list (`[]` clears), an
  /// absent key leaves it alone. At least one key must be present — `{}` is a
  /// deliberate 400 server-side.
  Future<void> saveQualifications(Map<String, dynamic> fields);

  Future<MyPortfolioDto> loadPortfolio();
  Future<void> savePortfolio(List<PortfolioItemDto> items);

  /// Mints a signed upload slot for one photo/video (503 while the media bucket
  /// is dormant server-side).
  Future<PortfolioUploadTicket> requestPortfolioUploadUrl({
    required String kind,
    required String contentType,
  });

  /// PUTs [bytes] to the signed ticket's url. Separated from the mint so the
  /// cubit can register the returned `storage_key` only after a successful PUT.
  Future<void> uploadPortfolioBytes({
    required PortfolioUploadTicket ticket,
    required PickedPortfolioMedia media,
  });

  /// The chip vocabulary the extended work-preferences fields share with the
  /// finishing form (`work_types`, `salary_period`, `availability`, shift).
  Future<WorkPrefOptionsDto> loadWorkPreferenceOptions();

  /// PUT the already-shaped work-preferences body (absent = leave alone).
  Future<void> saveWorkPreferences(Map<String, dynamic> fields);
}
