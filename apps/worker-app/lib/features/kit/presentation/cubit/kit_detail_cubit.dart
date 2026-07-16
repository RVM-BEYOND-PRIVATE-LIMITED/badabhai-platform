import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/error/failure.dart';
import '../../domain/interview_kit.dart';
import '../../domain/interview_kit_repository.dart';

enum KitDetailStatus { loading, ready, failed }

class KitDetailState extends Equatable {
  const KitDetailState({
    this.status = KitDetailStatus.loading,
    this.kit,
    this.failure,
  });

  final KitDetailStatus status;
  final InterviewKit? kit;

  /// The typed cause when [status] is `failed` — the failed view surfaces its
  /// honest reason instead of a generic "check internet" line.
  final Failure? failure;

  @override
  List<Object?> get props => <Object?>[status, kit, failure];
}

/// Drives the interview-kit detail: load a single trade's kit on open. A
/// failure shows the app's standard retry view.
class KitDetailCubit extends Cubit<KitDetailState> {
  KitDetailCubit(this._repo) : super(const KitDetailState());

  final InterviewKitRepository _repo;

  Future<void> load(String tradeKey) async {
    emit(const KitDetailState(status: KitDetailStatus.loading));
    try {
      final InterviewKit kit = await _repo.kit(tradeKey);
      if (isClosed) return; // screen popped before the kit resolved
      emit(KitDetailState(status: KitDetailStatus.ready, kit: kit));
    } on Failure catch (f) {
      if (isClosed) return;
      emit(KitDetailState(status: KitDetailStatus.failed, failure: f));
    }
  }

  /// Resolves a short-lived signed url for this trade's interview-kit PDF, or
  /// null if it could not be fetched (the screen then shows a user-safe
  /// message). Does NOT change [KitDetailState]. The url is returned for an
  /// immediate IN-APP fetch only and is never stored or logged.
  /// Lets a [Failure] PROPAGATE (does not swallow it to null) so
  /// `downloadSignedPdf` surfaces the ACTUAL reason instead of a blank generic
  /// line.
  Future<String?> resolveDownloadUrl(String tradeKey) =>
      _repo.downloadUrl(tradeKey);
}
