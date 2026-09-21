import 'dart:typed_data';

import '../../../core/api/api_client.dart'
    show
        ApiException,
        ApiClient,
        LanguageAbilityDto,
        MyLanguagesDto,
        MyOccupationsDto,
        MyPortfolioDto,
        MyQualificationsDto,
        MyWhatsappDto,
        PortfolioItemDto,
        PortfolioUploadTicket,
        WorkPrefOptionsDto;
import '../../../core/error/failure.dart';
import '../../../core/error/failure_mapper.dart';
import '../../../core/session/session_repository.dart';
import '../../../core/storage/signed_object_put.dart';
import '../domain/profile_edit_models.dart';
import '../domain/profile_edit_repository.dart';

/// Real Layer A profile-edit repository (issue #1545). Follows the app's
/// real-repo pattern: constructor takes the [ApiClient] + [SessionRepository],
/// reads the bearer token off the session, and maps transport errors to typed
/// [Failure]s.
///
/// [put] is an optional seam for the signed byte PUT: production takes a
/// [SignedObjectPut], tests inject a fake so no real network is touched.
class ProfileEditRepositoryImpl implements ProfileEditRepository {
  ProfileEditRepositoryImpl(
    this._api,
    this._session, {
    SignedObjectPut? put,
  }) : _put = put ?? SignedObjectPut();

  final ApiClient _api;
  final SessionRepository _session;
  final SignedObjectPut _put;

  String _requireToken() {
    final String? token = _session.sessionToken;
    if (token == null) throw const UnauthorizedFailure();
    return token;
  }

  @override
  Future<MyWhatsappDto> loadWhatsapp() async {
    try {
      return await _api.getMyWhatsapp(authToken: _requireToken());
    } catch (error) {
      throw mapError(error);
    }
  }

  @override
  Future<void> saveWhatsapp(String? whatsapp) async {
    try {
      await _api.setMyWhatsapp(
        whatsapp: whatsapp,
        authToken: _requireToken(),
      );
    } on ApiException catch (error) {
      throw _namedOrMapped(error);
    } catch (error) {
      throw mapError(error);
    }
  }

  @override
  Future<MyLanguagesDto> loadLanguages() async {
    try {
      return await _api.getMyLanguages(authToken: _requireToken());
    } catch (error) {
      throw mapError(error);
    }
  }

  @override
  Future<void> saveLanguages(List<LanguageAbilityDto> languages) async {
    try {
      await _api.setMyLanguages(
        languages: languages,
        authToken: _requireToken(),
      );
    } on ApiException catch (error) {
      throw _namedOrMapped(error);
    } catch (error) {
      throw mapError(error);
    }
  }

  @override
  Future<MyOccupationsDto> loadOccupations() async {
    try {
      return await _api.getMyOccupations(authToken: _requireToken());
    } catch (error) {
      throw mapError(error);
    }
  }

  @override
  Future<void> saveOccupations(List<String> roleIds) async {
    try {
      await _api.setMyOccupations(
        roleIds: roleIds,
        authToken: _requireToken(),
      );
    } on ApiException catch (error) {
      throw _namedOrMapped(error);
    } catch (error) {
      throw mapError(error);
    }
  }

  @override
  Future<MyQualificationsDto> loadQualifications() async {
    try {
      return await _api.getMyQualifications(authToken: _requireToken());
    } catch (error) {
      throw mapError(error);
    }
  }

  @override
  Future<void> saveQualifications(Map<String, dynamic> fields) async {
    try {
      await _api.updateQualifications(
        fields: fields,
        authToken: _requireToken(),
      );
    } on ApiException catch (error) {
      throw _namedOrMapped(error);
    } catch (error) {
      throw mapError(error);
    }
  }

  @override
  Future<MyPortfolioDto> loadPortfolio() async {
    try {
      return await _api.getMyPortfolio(authToken: _requireToken());
    } catch (error) {
      throw mapError(error);
    }
  }

  @override
  Future<void> savePortfolio(List<PortfolioItemDto> items) async {
    try {
      await _api.setMyPortfolio(
        items: items,
        authToken: _requireToken(),
      );
    } on ApiException catch (error) {
      throw _namedOrMapped(error);
    } catch (error) {
      throw mapError(error);
    }
  }

  @override
  Future<PortfolioUploadTicket> requestPortfolioUploadUrl({
    required String kind,
    required String contentType,
  }) async {
    try {
      return await _api.requestPortfolioUploadUrl(
        kind: kind,
        contentType: contentType,
        authToken: _requireToken(),
      );
    } catch (error) {
      throw mapError(error);
    }
  }

  @override
  Future<void> uploadPortfolioBytes({
    required PortfolioUploadTicket ticket,
    required PickedPortfolioMedia media,
  }) async {
    // PRIVACY: the signed url is a bearer credential; SignedObjectPut never
    // logs it and neither do we.
    await _put.send(
      uploadUrl: ticket.uploadUrl,
      bytes: Uint8List.fromList(media.bytes),
      contentType: media.contentType,
      what: 'portfolio ${media.kind}',
    );
  }

  @override
  Future<WorkPrefOptionsDto> loadWorkPreferenceOptions() async {
    try {
      return await _api.getWorkPreferenceOptions(authToken: _requireToken());
    } catch (error) {
      throw mapError(error);
    }
  }

  @override
  Future<void> saveWorkPreferences(Map<String, dynamic> fields) async {
    try {
      await _api.updateWorkPreferences(
        fields: fields,
        authToken: _requireToken(),
      );
    } on ApiException catch (error) {
      // A 400 here NAMES the offending input (unresolved city, bad slug). The
      // finishing repository surfaces that message for the same reason: the
      // worker's own input is a matching signal, never PII to redact.
      if (error.statusCode == 400 && error.message.trim().isNotEmpty) {
        throw InvalidRequestFailure(error.message);
      }
      throw mapError(error);
    } catch (error) {
      throw mapError(error);
    }
  }

  /// A 400 whose server message names the offending field is surfaced verbatim
  /// (same argument as [saveWorkPreferences]); anything else maps normally.
  Failure _namedOrMapped(ApiException error) {
    if (error.statusCode == 400 && error.message.trim().isNotEmpty) {
      return InvalidRequestFailure(error.message);
    }
    return mapError(error);
  }
}
