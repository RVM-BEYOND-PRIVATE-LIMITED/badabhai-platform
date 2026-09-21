import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/error/failure.dart';
import '../../domain/inbox_models.dart';
import '../../domain/inbox_repository.dart';

enum InboxThreadStatus {
  loading,

  /// The thread loaded and the reply composer is offered.
  ready,

  /// The server served its ONE neutral body: the thread is no longer available
  /// (expired / not the worker's / consent withdrawn — never distinguished).
  closed,
  failed,
}

class InboxThreadState extends Equatable {
  const InboxThreadState({
    this.status = InboxThreadStatus.loading,
    this.messages = const <InboxMessage>[],
    this.failure,
    this.sending = false,
    this.sendError,
  });

  final InboxThreadStatus status;
  final List<InboxMessage> messages;
  final Failure? failure;

  /// True while a reply is in flight — the composer's send button disables.
  final bool sending;

  /// A transient send failure (transport). A `closed` thread is a state, not an
  /// error, and never lands here.
  final Failure? sendError;

  InboxThreadState copyWith({
    InboxThreadStatus? status,
    List<InboxMessage>? messages,
    Object? failure = _sentinel,
    bool? sending,
    Object? sendError = _sentinel,
  }) {
    return InboxThreadState(
      status: status ?? this.status,
      messages: messages ?? this.messages,
      failure: failure == _sentinel ? this.failure : failure as Failure?,
      sending: sending ?? this.sending,
      sendError: sendError == _sentinel ? this.sendError : sendError as Failure?,
    );
  }

  @override
  List<Object?> get props =>
      <Object?>[status, messages, failure, sending, sendError];
}

const Object _sentinel = Object();

/// Drives one relay thread: load the messages, offer the reply composer, and
/// mark the inbound messages read on a successful load (audit only).
class InboxThreadCubit extends Cubit<InboxThreadState> {
  InboxThreadCubit(this._repo) : super(const InboxThreadState());

  final InboxRepository _repo;
  String? _unlockId;

  Future<void> load(String unlockId) async {
    _unlockId = unlockId;
    emit(const InboxThreadState(status: InboxThreadStatus.loading));
    try {
      final List<InboxMessage>? messages = await _repo.thread(unlockId);
      if (isClosed) return;
      if (messages == null) {
        emit(const InboxThreadState(status: InboxThreadStatus.closed));
        return;
      }
      emit(InboxThreadState(
        status: InboxThreadStatus.ready,
        messages: messages,
      ));
      // Opening the thread IS the read. Best-effort: a failed audit write must
      // not blank a thread the worker can already read.
      try {
        await _repo.markRead(unlockId);
      } catch (_) {
        // Audit-only write; the read above already succeeded.
      }
    } on Failure catch (f) {
      if (isClosed) return;
      emit(InboxThreadState(status: InboxThreadStatus.failed, failure: f));
    }
  }

  /// Sends a free-text reply. Returns true when it landed; false when the
  /// server's neutral body closed the thread (the caller clears the composer).
  Future<bool> reply(String text) async {
    final String? unlockId = _unlockId;
    final String trimmed = text.trim();
    if (unlockId == null || trimmed.isEmpty || state.sending) return false;

    emit(state.copyWith(sending: true, sendError: null));
    try {
      final bool ok = await _repo.reply(unlockId, trimmed);
      if (isClosed) return false;
      if (!ok) {
        emit(state.copyWith(status: InboxThreadStatus.closed, sending: false));
        return false;
      }
      emit(state.copyWith(sending: false));
      await load(unlockId);
      return true;
    } on Failure catch (f) {
      if (isClosed) return false;
      emit(state.copyWith(sending: false, sendError: f));
      return false;
    }
  }
}
