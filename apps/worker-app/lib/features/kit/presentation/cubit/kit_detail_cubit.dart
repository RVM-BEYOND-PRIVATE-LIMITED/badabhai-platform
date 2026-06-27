import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/error/failure.dart';
import '../../domain/interview_kit.dart';
import '../../domain/interview_kit_repository.dart';

enum KitDetailStatus { loading, ready, failed }

class KitDetailState extends Equatable {
  const KitDetailState({this.status = KitDetailStatus.loading, this.kit});

  final KitDetailStatus status;
  final InterviewKit? kit;

  @override
  List<Object?> get props => <Object?>[status, kit];
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
    } on Failure catch (_) {
      if (isClosed) return;
      emit(const KitDetailState(status: KitDetailStatus.failed));
    }
  }

  /// Resolves a short-lived signed url for this trade's interview-kit PDF, or
  /// null if it could not be fetched (the screen then shows a user-safe
  /// message). Does NOT change [KitDetailState]. The url is returned for
  /// immediate launch only and is never stored or logged.
  Future<String?> resolveDownloadUrl(String tradeKey) async {
    try {
      return await _repo.downloadUrl(tradeKey);
    } on Failure catch (_) {
      return null;
    }
  }
}
