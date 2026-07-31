import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/data/job_posting_chat_models.dart';
import '../../../../core/data/payer_api_client.dart';

enum ChatSessionsStatus { initial, loading, ready, error }

class ChatSessionsState extends Equatable {
  const ChatSessionsState({
    this.status = ChatSessionsStatus.initial,
    this.sessions = const <JobPostingChatSessionSummary>[],
  });

  final ChatSessionsStatus status;

  /// RESUMABLE sessions only (`active` / `draft_ready`), newest-first.
  final List<JobPostingChatSessionSummary> sessions;

  /// The one the Jobs tab offers to pick up.
  JobPostingChatSessionSummary? get mostRecent =>
      sessions.isEmpty ? null : sessions.first;

  ChatSessionsState copyWith({
    ChatSessionsStatus? status,
    List<JobPostingChatSessionSummary>? sessions,
  }) {
    return ChatSessionsState(
      status: status ?? this.status,
      sessions: sessions ?? this.sessions,
    );
  }

  @override
  List<Object?> get props => <Object?>[status, sessions];
}

/// Loads this payer's in-progress job-posting chats
/// (`GET /payer/job-posting-chat/sessions`) — the MOBILE side of ADR-0035's
/// cross-device pickup. A conversation started in the web portal is listed here
/// because ownership is by `payer_id` from the bearer, not by device.
///
/// A load failure is a SILENT, non-blocking degrade to "nothing to resume": this
/// drives an optional card on a tab whose primary job is listing postings, so an
/// error banner here would be noise. The status is still exposed so a caller can
/// tell "no sessions" from "could not check".
class ChatSessionsCubit extends Cubit<ChatSessionsState> {
  ChatSessionsCubit(this._api) : super(const ChatSessionsState());

  final PayerApiClient _api;

  Future<void> load() async {
    emit(state.copyWith(status: ChatSessionsStatus.loading));
    try {
      final List<JobPostingChatSessionSummary> all =
          await _api.fetchJobPostingChatSessions();
      emit(
        ChatSessionsState(
          status: ChatSessionsStatus.ready,
          sessions: all
              .where((JobPostingChatSessionSummary s) => s.isResumable)
              .toList(growable: false),
        ),
      );
    } catch (_) {
      // Keep whatever was already known; never surface a fabricated empty list
      // as a confident "you have no chat in progress".
      emit(state.copyWith(status: ChatSessionsStatus.error));
    }
  }
}
