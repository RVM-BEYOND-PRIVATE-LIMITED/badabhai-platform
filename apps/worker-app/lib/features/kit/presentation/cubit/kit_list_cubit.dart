import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/error/failure.dart';
import '../../domain/interview_kit.dart';
import '../../domain/interview_kit_repository.dart';

enum KitListStatus { loading, ready, failed }

class KitListState extends Equatable {
  const KitListState({
    this.status = KitListStatus.loading,
    this.items = const <KitListItem>[],
    this.failure,
  });

  final KitListStatus status;
  final List<KitListItem> items;

  /// The typed cause when [status] is `failed` — the failed view surfaces its
  /// honest reason instead of a generic "check internet" line.
  final Failure? failure;

  @override
  List<Object?> get props => <Object?>[status, items, failure];
}

/// Drives the interview-kit list: load the available kits on open. A failure
/// shows the app's standard retry view.
class KitListCubit extends Cubit<KitListState> {
  KitListCubit(this._repo) : super(const KitListState());

  final InterviewKitRepository _repo;

  Future<void> load() async {
    emit(const KitListState(status: KitListStatus.loading));
    try {
      final List<KitListItem> items = await _repo.listKits();
      if (isClosed) return; // screen popped before the list resolved
      emit(KitListState(status: KitListStatus.ready, items: items));
    } on Failure catch (f) {
      if (isClosed) return;
      emit(KitListState(status: KitListStatus.failed, failure: f));
    }
  }
}
