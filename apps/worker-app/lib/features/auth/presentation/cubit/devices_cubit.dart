import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/auth/auth_api.dart';
import '../../../../core/auth/auth_error_messages.dart';
import '../../../../core/auth/auth_failure.dart';
import '../../domain/auth_session_manager.dart';

enum DevicesStatus { loading, ready, failed }

class DevicesState extends Equatable {
  const DevicesState({
    this.status = DevicesStatus.loading,
    this.devices = const <AuthDevice>[],
    this.message,
  });

  final DevicesStatus status;
  final List<AuthDevice> devices;
  final String? message;

  DevicesState copyWith({
    DevicesStatus? status,
    List<AuthDevice>? devices,
    String? message,
  }) =>
      DevicesState(
        status: status ?? this.status,
        devices: devices ?? this.devices,
        message: message,
      );

  @override
  List<Object?> get props => <Object?>[status, devices, message];
}

/// Lists the worker's known devices and revokes others. The current device is
/// flagged (and not revocable from here).
class DevicesCubit extends Cubit<DevicesState> {
  DevicesCubit(this._manager, {String locale = 'hi'})
      : _locale = locale,
        super(const DevicesState());

  final AuthSessionManager _manager;
  final String _locale;

  Future<void> load() async {
    emit(const DevicesState(status: DevicesStatus.loading));
    try {
      final List<AuthDevice> devices = await _manager.listDevices();
      if (isClosed) return;
      emit(DevicesState(status: DevicesStatus.ready, devices: devices));
    } on AuthFailure catch (failure) {
      if (isClosed) return;
      emit(DevicesState(
        status: DevicesStatus.failed,
        message: authErrorMessage(failure, _locale),
      ));
    } catch (_) {
      // #367 — a non-AuthFailure (e.g. a PlatformException from the secure
      // store) otherwise escaped and left this stuck on `loading`: a permanent
      // spinner with no retry affordance, since the failed view is what carries
      // one. Fail to the honest failed state instead.
      if (isClosed) return;
      emit(DevicesState(
        status: DevicesStatus.failed,
        message: authErrorMessage(
            const AuthFailure(AuthErrorCode.unknown), _locale),
      ));
    }
  }

  Future<void> revoke(String deviceId) async {
    try {
      await _manager.revokeDevice(deviceId);
    } catch (_) {
      // #367 — was `on AuthFailure`, so a non-AuthFailure escaped revoke() and
      // skipped the reload below, leaving a revoked-looking list that never
      // refreshed. Any failure is surfaced the same way: re-load, because the
      // list is the source of truth.
    }
    await load();
  }
}
