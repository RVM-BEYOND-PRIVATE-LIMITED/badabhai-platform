import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/error/failure.dart';
import '../../domain/consent_repository.dart';
import '../../domain/employer_contact.dart';

enum EmployerContactStatus { loading, ready, submitting, failed }

class EmployerContactState extends Equatable {
  const EmployerContactState({
    this.status = EmployerContactStatus.loading,
    this.enabled = false,
    this.failure,
  });

  final EmployerContactStatus status;

  /// Server truth: ON only when the latest consent row grants BOTH employer
  /// purposes. Never set optimistically.
  final bool enabled;
  final Failure? failure;

  @override
  List<Object?> get props => <Object?>[status, enabled, failure];
}

/// The stop-employer-contact switch (E0 C-2, FE #1630).
///
/// Reads server truth on load and AFTER a write (never optimistic-only), and
/// deliberately does NOT log the worker out — unlike [ConsentWithdrawCubit],
/// which is the all-or-nothing exit.
class EmployerContactCubit extends Cubit<EmployerContactState> {
  EmployerContactCubit(this._repo) : super(const EmployerContactState());

  final ConsentRepository _repo;
  bool _busy = false;

  Future<void> load() async {
    if (_busy) return;
    _busy = true;
    emit(const EmployerContactState(status: EmployerContactStatus.loading));
    try {
      final EmployerContactInfo state = await _repo.employerContactState();
      if (isClosed) return;
      emit(EmployerContactState(
        status: EmployerContactStatus.ready,
        enabled: state.enabled,
      ));
    } on Failure catch (f) {
      if (isClosed) return;
      emit(EmployerContactState(
        status: EmployerContactStatus.failed,
        failure: f,
      ));
    } finally {
      _busy = false;
    }
  }

  /// Writes the exit, then re-reads server state. Returns true when it landed.
  Future<bool> withdraw() async {
    if (_busy) return false;
    _busy = true;
    emit(EmployerContactState(
      status: EmployerContactStatus.submitting,
      enabled: state.enabled,
    ));
    try {
      await _repo.withdrawEmployerContact();
      if (isClosed) return false;
      // Reflect the SERVER's answer, not the tap: a no-op write (already off)
      // still resolves to OFF after the re-read.
      final EmployerContactInfo fresh = await _repo.employerContactState();
      if (isClosed) return false;
      emit(EmployerContactState(
        status: EmployerContactStatus.ready,
        enabled: fresh.enabled,
      ));
      return true;
    } on Failure catch (f) {
      if (isClosed) return false;
      emit(EmployerContactState(
        status: EmployerContactStatus.failed,
        enabled: state.enabled,
        failure: f,
      ));
      return false;
    } finally {
      _busy = false;
    }
  }
}
