import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/error/failure.dart';
import '../../domain/inbox_models.dart';
import '../../domain/inbox_repository.dart';

enum InboxStatus { loading, ready, empty, failed }

class InboxState extends Equatable {
  const InboxState({
    this.status = InboxStatus.loading,
    this.threads = const <InboxThread>[],
    this.failure,
  });

  final InboxStatus status;
  final List<InboxThread> threads;

  /// The typed cause when [status] is `failed` — the view shows its honest
  /// reason instead of a generic line.
  final Failure? failure;

  @override
  List<Object?> get props => <Object?>[status, threads, failure];
}

/// Drives the inbox: the worker's own relay threads, faceless (E0, FE #1628).
class InboxCubit extends Cubit<InboxState> {
  InboxCubit(this._repo) : super(const InboxState());

  final InboxRepository _repo;
  bool _loading = false;

  Future<void> load() async {
    if (_loading) return;
    _loading = true;
    emit(const InboxState(status: InboxStatus.loading));
    try {
      final List<InboxThread> threads = await _repo.threads();
      if (isClosed) return;
      emit(InboxState(
        status:
            threads.isEmpty ? InboxStatus.empty : InboxStatus.ready,
        threads: threads,
      ));
    } on Failure catch (f) {
      if (isClosed) return;
      emit(InboxState(status: InboxStatus.failed, failure: f));
    } finally {
      _loading = false;
    }
  }
}
