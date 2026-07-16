import 'package:equatable/equatable.dart';

/// One assistant turn from the profiling chat: bada bhai's [reply] plus any
/// [followups].
///
/// [followups] are the backend's `suggested_followups` — short tap-to-answer
/// chips so a low-literacy worker can answer without typing. Empty when the
/// backend sent none (including when the reply was blocked / a safe fallback).
class ChatTurn extends Equatable {
  const ChatTurn({required this.reply, this.followups = const <String>[]});

  final String reply;
  final List<String> followups;

  @override
  List<Object?> get props => <Object?>[reply, followups];
}
