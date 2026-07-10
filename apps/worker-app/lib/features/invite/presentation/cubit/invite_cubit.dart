import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:share_plus/share_plus.dart';

import '../../../../core/error/failure.dart';
import '../../domain/invite_repository.dart';

/// Hands invite text to the platform share sheet. Injected so tests never touch
/// the native share plugin.
typedef ShareFn = Future<void> Function(String text);

Future<void> _defaultShare(String text) => Share.share(text);

enum InviteStatus { loading, ready, error }

class InviteState extends Equatable {
  const InviteState({
    this.status = InviteStatus.loading,
    this.link,
    this.failure,
  });

  final InviteStatus status;
  final InviteLink? link;
  final Failure? failure;

  InviteState copyWith({InviteStatus? status, InviteLink? link, Failure? failure}) =>
      InviteState(
        status: status ?? this.status,
        link: link ?? this.link,
        failure: failure ?? this.failure,
      );

  @override
  List<Object?> get props => <Object?>[status, link, failure];
}

/// Creates a referral invite on open and shares it via the platform sheet (A3).
class InviteCubit extends Cubit<InviteState> {
  InviteCubit(this._repo, {ShareFn? share})
      : _share = share ?? _defaultShare,
        super(const InviteState());

  final InviteRepository _repo;
  final ShareFn _share;

  /// The Hinglish message wrapped around the invite link when sharing.
  String shareText(InviteLink link) =>
      'BadaBhai par apna profile banao aur factory jobs pao — bina test, bas '
      'baat-cheet se. Yahan se shuru karo: ${link.url}';

  Future<void> load() async {
    emit(const InviteState(status: InviteStatus.loading));
    try {
      final InviteLink link = await _repo.createInvite();
      if (isClosed) return;
      emit(InviteState(status: InviteStatus.ready, link: link));
    } on Failure catch (f) {
      if (isClosed) return;
      emit(InviteState(status: InviteStatus.error, failure: f));
    }
  }

  /// Opens the share sheet with the current invite link. No-op until loaded.
  Future<void> shareInvite() async {
    final InviteLink? link = state.link;
    if (link == null) return;
    await _share(shareText(link));
  }
}
