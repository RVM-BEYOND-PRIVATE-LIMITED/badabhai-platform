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
    this.revokingId,
  });

  final DevicesStatus status;
  final List<AuthDevice> devices;
  final String? message;

  /// Id of the device whose revoke is in flight, or null when idle. Like
  /// [message], it is not `??`-merged: each copyWith call sets it explicitly, so
  /// omitting it clears the in-flight flag.
  final String? revokingId;

  DevicesState copyWith({
    DevicesStatus? status,
    List<AuthDevice>? devices,
    String? message,
    String? revokingId,
  }) =>
      DevicesState(
        status: status ?? this.status,
        devices: devices ?? this.devices,
        message: message,
        revokingId: revokingId,
      );

  @override
  List<Object?> get props =>
      <Object?>[status, devices, message, revokingId];
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
    // #464 (FI-001) — this reads like a synchronous first line and therefore a
    // safe emit. It is not: revoke() below awaits _manager.revokeDevice() and
    // only THEN calls load(), so this emit is reached AFTER an await. Every
    // worker-app cubit is screen-scoped (BlocProvider is created inside
    // DevicesScreen.build), so it closes on pop — a worker who confirmed
    // "Hatayein" on a stolen phone and immediately backed out landed here on a
    // closed cubit and got "Bad state: Cannot emit new states after calling
    // close". An emit's safety depends on the whole call graph, not on the
    // method it sits in.
    if (isClosed) return;
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
    // Flag this device as revoke-in-flight so the tile can show a spinner and
    // block duplicate taps. load() (called below) emits fresh states, which
    // carry no revokingId, clearing it.
    if (isClosed) return;
    emit(state.copyWith(revokingId: deviceId));
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
