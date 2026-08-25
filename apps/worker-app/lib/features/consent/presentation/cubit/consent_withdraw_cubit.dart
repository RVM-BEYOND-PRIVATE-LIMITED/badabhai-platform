import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/di/locator.dart';
import '../../../../core/error/failure.dart';
import '../../../auth/domain/auth_session_manager.dart';
import '../../domain/consent_repository.dart';

enum ConsentWithdrawStatus { idle, submitting, success, failure }

class ConsentWithdrawState extends Equatable {
  const ConsentWithdrawState({
    this.status = ConsentWithdrawStatus.idle,
    this.failure,
  });

  final ConsentWithdrawStatus status;

  /// The typed cause when [status] is `failure` — the UI surfaces its honest
  /// reason (via failureReason) instead of a generic "something went wrong".
  final Failure? failure;

  bool get isSubmitting => status == ConsentWithdrawStatus.submitting;

  @override
  List<Object?> get props => <Object?>[status, failure];
}

/// Drives DPDP consent withdrawal from Settings → Privacy.
///
/// The backend (`POST /consent/withdraw`, consent.service.ts) stamps `revokedAt`
/// on the worker's latest consent row AND revokes EVERY active session — the
/// current device included. So a SUCCESSFUL withdraw is a session-ending action:
/// the only honest local response is a hard-logout to phone login. The next OTP
/// login returns `consent_accepted:false`, which drives the router's consent gate
/// so the worker must re-consent before using the app again (DPDP).
class ConsentWithdrawCubit extends Cubit<ConsentWithdrawState> {
  ConsentWithdrawCubit(this._repo) : super(const ConsentWithdrawState());

  final ConsentRepository _repo;

  Future<void> withdraw() async {
    if (isClosed) return;
    emit(const ConsentWithdrawState(status: ConsentWithdrawStatus.submitting));
    try {
      await _repo.withdrawConsent();
    } on Failure catch (failure) {
      if (isClosed) return;
      emit(ConsentWithdrawState(
        status: ConsentWithdrawStatus.failure,
        failure: failure,
      ));
      return;
    }
    // Server revoked EVERY session (incl. this device) + the consent record.
    // Hard-log-out locally so the app returns to phone login and the worker
    // re-consents on the next OTP login. Done LAST: logout() flips AuthStatus and
    // the router tears this screen (and cubit) down, so no emit may follow it.
    // The `success` emit only runs in the plugin-free graph (no manager wired,
    // e.g. unit tests) where there is no router to drive.
    if (locator.isRegistered<AuthSessionManager>()) {
      await locator<AuthSessionManager>().logout();
    } else if (!isClosed) {
      emit(const ConsentWithdrawState(status: ConsentWithdrawStatus.success));
    }
  }
}
