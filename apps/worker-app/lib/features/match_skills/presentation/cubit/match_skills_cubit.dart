import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/error/failure.dart';
import '../../domain/match_skill.dart';
import '../../domain/match_skills_repository.dart';

enum MatchSkillsStatus { loading, ready, failed }

class MatchSkillsState extends Equatable {
  const MatchSkillsState({
    this.status = MatchSkillsStatus.loading,
    this.skills = const <MatchSkill>[],
    this.savingId,
    this.clearing = false,
    this.refreshing = false,
    this.failure,
    this.writeFailure,
    this.writeSeq = 0,
    this.turnedOff,
    this.clearSeq = 0,
  });

  final MatchSkillsStatus status;

  /// Server truth, in the server's order. Switched-off rows stay listed.
  final List<MatchSkill> skills;

  /// The row whose PUT is in flight; every switch is locked while it is set.
  final String? savingId;

  /// True while clear-all is in flight.
  final bool clearing;

  /// True while the list is re-read after a failed write. Every switch stays
  /// locked until it lands, so the older read cannot overwrite a newer write.
  final bool refreshing;

  /// Why the LIST could not be loaded ([MatchSkillsStatus.failed]).
  final Failure? failure;

  /// Why the last WRITE failed. Paired with [writeSeq] so two identical
  /// failures in a row still reach the screen's listener.
  final Failure? writeFailure;
  final int writeSeq;

  /// How many switches the last clear-all turned off — rows that were on
  /// before it and are off after its re-read. Paired with [clearSeq] for the
  /// same reason as [writeSeq].
  final int? turnedOff;
  final int clearSeq;

  bool get busy => savingId != null || clearing || refreshing;
  bool get anyOn => skills.any((MatchSkill s) => s.wants);

  MatchSkillsState copyWith({
    MatchSkillsStatus? status,
    List<MatchSkill>? skills,
    String? Function()? savingId,
    bool? clearing,
    bool? refreshing,
    Failure? Function()? failure,
    Failure? writeFailure,
    int? writeSeq,
    int? turnedOff,
    int? clearSeq,
  }) =>
      MatchSkillsState(
        status: status ?? this.status,
        skills: skills ?? this.skills,
        savingId: savingId != null ? savingId() : this.savingId,
        clearing: clearing ?? this.clearing,
        refreshing: refreshing ?? this.refreshing,
        failure: failure != null ? failure() : this.failure,
        writeFailure: writeFailure ?? this.writeFailure,
        writeSeq: writeSeq ?? this.writeSeq,
        turnedOff: turnedOff ?? this.turnedOff,
        clearSeq: clearSeq ?? this.clearSeq,
      );

  @override
  List<Object?> get props => <Object?>[
        status,
        skills,
        savingId,
        clearing,
        refreshing,
        failure,
        writeFailure,
        writeSeq,
        turnedOff,
        clearSeq,
      ];
}

/// The match-skill toggle screen (E4, #1828/#1831) — the worker's exit from
/// being shown to employers, one kind of work at a time or all at once.
///
/// Never optimistic: a switch moves only when the server says what it now
/// holds, and every failed write re-reads the list — with the switches locked
/// until it lands — so the screen can only render server truth.
class MatchSkillsCubit extends Cubit<MatchSkillsState> {
  MatchSkillsCubit(this._repo) : super(const MatchSkillsState());

  final MatchSkillsRepository _repo;

  Future<void> load() async {
    if (state.busy) return;
    emit(const MatchSkillsState());
    try {
      final List<MatchSkill> skills = await _repo.list();
      if (isClosed) return;
      emit(MatchSkillsState(status: MatchSkillsStatus.ready, skills: skills));
    } on Failure catch (f) {
      if (isClosed) return;
      emit(MatchSkillsState(status: MatchSkillsStatus.failed, failure: f));
    }
  }

  /// Sends the RESULTING state for [skillId] and renders what the server
  /// echoes back.
  Future<void> setWants(String skillId, {required bool wants}) async {
    if (state.status != MatchSkillsStatus.ready || state.busy) return;
    emit(state.copyWith(savingId: () => skillId));
    try {
      final bool held = await _repo.setWants(skillId, wants: wants);
      if (isClosed) return;
      emit(state.copyWith(
        savingId: () => null,
        skills: <MatchSkill>[
          for (final MatchSkill s in state.skills)
            s.skillId == skillId ? s.withWants(held) : s,
        ],
      ));
    } on Failure catch (f) {
      if (isClosed) return;
      // 400 (not in the vocabulary) and 404 (not held) both mean this list is
      // stale; any other failure leaves the switch unsure. Re-read either way.
      emit(state.copyWith(
        savingId: () => null,
        refreshing: true,
        writeFailure: f,
        writeSeq: state.writeSeq + 1,
      ));
      await _rereadThenUnlock();
    }
  }

  /// Turns every kind of work off in one call, then re-reads the list.
  ///
  /// The count it reports is the switches THIS call turned off, never the
  /// server's `cleared` — that counts every row the worker holds, already-off
  /// ones included (#1850).
  Future<void> clearAll() async {
    if (state.status != MatchSkillsStatus.ready || state.busy) return;
    final Set<String> wereOn = <String>{
      for (final MatchSkill s in state.skills)
        if (s.wants) s.skillId,
    };
    emit(state.copyWith(clearing: true));
    try {
      await _repo.clearAll();
      if (isClosed) return;
      // The server confirmed the clear; if the re-read fails, every row is
      // still known to be off.
      final List<MatchSkill> fresh = await _tryList() ??
          <MatchSkill>[for (final MatchSkill s in state.skills) s.withWants(false)];
      if (isClosed) return;
      emit(state.copyWith(
        clearing: false,
        skills: fresh,
        turnedOff: fresh
            .where((MatchSkill s) => !s.wants && wereOn.contains(s.skillId))
            .length,
        clearSeq: state.clearSeq + 1,
      ));
    } on Failure catch (f) {
      if (isClosed) return;
      emit(state.copyWith(
        clearing: false,
        refreshing: true,
        writeFailure: f,
        writeSeq: state.writeSeq + 1,
      ));
      await _rereadThenUnlock();
    }
  }

  /// The re-read after a failed write. [MatchSkillsState.refreshing] holds
  /// every switch until it lands; a failed read keeps the rows as they were.
  Future<void> _rereadThenUnlock() async {
    final List<MatchSkill>? fresh = await _tryList();
    if (isClosed) return;
    emit(state.copyWith(refreshing: false, skills: fresh));
  }

  Future<List<MatchSkill>?> _tryList() async {
    try {
      return await _repo.list();
    } on Failure {
      return null;
    }
  }
}
