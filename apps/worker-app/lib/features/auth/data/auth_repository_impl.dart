import '../../../core/api/api_client.dart';
import '../../../core/error/failure_mapper.dart';
import '../../../core/session/session_repository.dart';
import '../domain/auth_repository.dart';

class AuthRepositoryImpl implements AuthRepository {
  AuthRepositoryImpl(this._api, this._session);

  final ApiClient _api;
  final SessionRepository _session;

  @override
  Future<void> requestOtp(String phoneE164) async {
    try {
      await _api.requestOtp(phoneE164);
    } catch (error) {
      throw mapError(error);
    }
  }

  @override
  Future<void> verifyOtp({
    required String phoneE164,
    required String otp,
  }) async {
    try {
      final VerifyOtpResult result = await _api.verifyOtp(phoneE164, otp);
      _session.setWorker(
        phone: phoneE164,
        workerId: result.workerId,
        sessionToken: result.accessToken,
      );
    } catch (error) {
      throw mapError(error);
    }
  }
}
