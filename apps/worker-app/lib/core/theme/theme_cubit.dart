import 'package:equatable/equatable.dart';
import 'package:flutter/foundation.dart' show kReleaseMode;
import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../features/settings/domain/display_prefs.dart';
import '../../features/settings/domain/display_prefs_repository.dart';

/// The app-wide theme state: the worker's choice plus whether the rollout
/// switch is open for them.
///
/// **A closed (or unknown) switch is always [ThemeMode.light].** That is the
/// rollback path (#2818): closing `THEME_ROLLOUT` returns every app to its
/// default at the next start or resume, with no deploy.
class ThemeState extends Equatable {
  const ThemeState({
    required this.choice,
    required this.open,
    this.debugDark = false,
  });

  /// Light, no choice — also the state before the first GET answers.
  static const ThemeState closed = ThemeState(
    choice: DisplayTheme.light,
    open: false,
  );

  final DisplayTheme choice;
  final bool open;

  /// Debug-only preview override (#2824 item 8). Always false in release: the
  /// setter asserts it, and no release UI calls it.
  final bool debugDark;

  /// Whether Settings may show the Appearance row.
  bool get canChoose => open;

  /// What `MaterialApp.themeMode` gets. `system` follows the phone live.
  ThemeMode get themeMode {
    if (debugDark) return ThemeMode.dark;
    return switch (choice) {
      DisplayTheme.dark when open => ThemeMode.dark,
      DisplayTheme.system when open => ThemeMode.system,
      _ => ThemeMode.light,
    };
  }

  ThemeState copyWith({DisplayTheme? choice, bool? open, bool? debugDark}) {
    return ThemeState(
      choice: choice ?? this.choice,
      open: open ?? this.open,
      debugDark: debugDark ?? this.debugDark,
    );
  }

  @override
  List<Object?> get props => <Object?>[choice, open, debugDark];
}

/// Holds [ThemeState] and talks to the repository. Registered as a lazy
/// singleton, so the same instance drives `MaterialApp` and the Settings row.
class ThemeCubit extends Cubit<ThemeState> {
  ThemeCubit(this._repository) : super(ThemeState.closed);

  final DisplayPrefsRepository _repository;

  /// Reads the server preference. Called on sign-in and on app resume.
  Future<void> load() async {
    final DisplayPrefs prefs = await _repository.read();
    _emit(prefs);
  }

  /// Applies a choice at once and saves it. A closed switch ignores the call.
  Future<void> choose(DisplayTheme choice) async {
    if (!state.open) return;
    // Optimistic: the row and the tree change together, before the network.
    emit(state.copyWith(choice: choice));
    final DisplayPrefs prefs = await _repository.write(choice);
    _emit(prefs);
  }

  /// Sends a queued offline choice and re-reads the server value.
  Future<void> flushPending() async {
    await _repository.flushPending();
    await load();
  }

  /// Signing out returns the app to Light and drops the device cache.
  void onLogout() {
    _repository.onLogout();
    emit(ThemeState.closed);
  }

  /// Debug builds only: preview the ink theme even while the switch is closed.
  void debugSetDark(bool on) {
    assert(!kReleaseMode, 'the dark preview is a debug-only control');
    if (kReleaseMode) return;
    emit(state.copyWith(debugDark: on));
  }

  void _emit(DisplayPrefs prefs) {
    if (isClosed) return;
    emit(
      ThemeState(
        choice: prefs.theme,
        open: prefs.themeOpen,
        debugDark: state.debugDark,
      ),
    );
  }
}
