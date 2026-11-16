import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/error/failure.dart';
import '../../domain/search_visibility_repository.dart';

enum SearchVisibilityStatus {
  loading,
  ready,

  /// `404` — `SEARCH_EXIT_ENABLED` is off, so the control is HIDDEN.
  unavailable,

  /// `503` (or any other failure) — retryable; the control stays visible.
  failed,
}

class SearchVisibilityState extends Equatable {
  const SearchVisibilityState({
    this.status = SearchVisibilityStatus.loading,
    this.visible = true,
    this.failure,
  });

  final SearchVisibilityStatus status;

  /// Server truth. ON means companies can find him; OFF hides him from company
  /// SEARCH only (applying still works, and a company he applied to can still
  /// open his contact).
  final bool visible;
  final Failure? failure;

  bool get isReady => status == SearchVisibilityStatus.ready;
  bool get isUnavailable => status == SearchVisibilityStatus.unavailable;

  @override
  List<Object?> get props => <Object?>[status, visible, failure];
}

/// The "Companies can find me in search" switch (#2753 item 6).
///
/// Reads server truth on load and re-reads after every write (never
/// optimistic-only). A `404` hides the control; a `503` stays visible with a
/// retry. This is the LIGHTER exit than withdrawing employer contact.
class SearchVisibilityCubit extends Cubit<SearchVisibilityState> {
  SearchVisibilityCubit(this._repo) : super(const SearchVisibilityState());

  final SearchVisibilityRepository _repo;
  bool _busy = false;

  Future<void> load() async {
    if (_busy) return;
    _busy = true;
    emit(const SearchVisibilityState());
    try {
      final bool visible = (await _repo.read()).visible;
      if (isClosed) return;
      emit(SearchVisibilityState(
        status: SearchVisibilityStatus.ready,
        visible: visible,
      ));
    } on Failure catch (f) {
      if (isClosed) return;
      emit(SearchVisibilityState(
        status: _switchOff(f)
            ? SearchVisibilityStatus.unavailable
            : SearchVisibilityStatus.failed,
        visible: state.visible,
        failure: _switchOff(f) ? null : f,
      ));
    } finally {
      _busy = false;
    }
  }

  /// Writes the RESULTING state, then renders the server's answer. Returns true
  /// when the switch now holds the requested value.
  Future<bool> setVisible(bool visible) async {
    if (_busy) return false;
    _busy = true;
    emit(SearchVisibilityState(
      status: SearchVisibilityStatus.ready,
      visible: state.visible,
    ));
    try {
      final bool fresh = (await _repo.setVisible(visible)).visible;
      if (isClosed) return false;
      emit(SearchVisibilityState(
        status: SearchVisibilityStatus.ready,
        visible: fresh,
      ));
      return fresh == visible;
    } on Failure catch (f) {
      if (isClosed) return false;
      emit(SearchVisibilityState(
        status: _switchOff(f)
            ? SearchVisibilityStatus.unavailable
            : SearchVisibilityStatus.failed,
        visible: state.visible,
        failure: _switchOff(f) ? null : f,
      ));
      return false;
    } finally {
      _busy = false;
    }
  }

  static bool _switchOff(Failure f) =>
      f is ServerFailure && f.statusCode == 404;
}
