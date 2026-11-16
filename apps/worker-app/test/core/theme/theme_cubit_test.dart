import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/theme/theme_cubit.dart';
import 'package:badabhai_worker_app/features/settings/domain/display_prefs.dart';
import 'package:badabhai_worker_app/features/settings/domain/display_prefs_repository.dart';

class _FakeRepo implements DisplayPrefsRepository {
  _FakeRepo({this.next = DisplayPrefs.closed});

  DisplayPrefs next;
  int reads = 0;
  int writes = 0;
  int flushes = 0;
  int logouts = 0;
  DisplayTheme? lastWritten;

  @override
  Future<DisplayPrefs> read() async {
    reads++;
    return next;
  }

  @override
  Future<DisplayPrefs> write(DisplayTheme theme) async {
    writes++;
    lastWritten = theme;
    next = DisplayPrefs(theme: theme, themeOpen: true);
    return next;
  }

  @override
  Future<void> flushPending() async {
    flushes++;
  }

  @override
  void onLogout() {
    logouts++;
    next = DisplayPrefs.closed;
  }
}

void main() {
  group('ThemeState.themeMode', () {
    test('platform dark with the switch closed is LIGHT', () {
      // The switch, not the phone, decides. This is the rollback path.
      const ThemeState state = ThemeState(
        choice: DisplayTheme.system,
        open: false,
      );
      expect(state.themeMode, ThemeMode.light);
    });

    test('unknown state (before the first GET) is LIGHT', () {
      expect(ThemeState.closed.themeMode, ThemeMode.light);
    });

    test('an open switch honours dark', () {
      const ThemeState state = ThemeState(
        choice: DisplayTheme.dark,
        open: true,
      );
      expect(state.themeMode, ThemeMode.dark);
    });

    test('an open switch honours System (follows the phone live)', () {
      const ThemeState state = ThemeState(
        choice: DisplayTheme.system,
        open: true,
      );
      expect(state.themeMode, ThemeMode.system);
    });

    test('the debug preview wins over a closed switch', () {
      const ThemeState state = ThemeState(
        choice: DisplayTheme.light,
        open: false,
        debugDark: true,
      );
      expect(state.themeMode, ThemeMode.dark);
    });
  });

  group('ThemeCubit', () {
    test('load applies the server preference', () async {
      final _FakeRepo repo = _FakeRepo(
        next: const DisplayPrefs(
          theme: DisplayTheme.dark,
          themeOpen: true,
        ),
      );
      final ThemeCubit cubit = ThemeCubit(repo);
      await cubit.load();
      expect(cubit.state.canChoose, isTrue);
      expect(cubit.state.themeMode, ThemeMode.dark);
    });

    test('a closed switch clears a previously-open choice', () async {
      final _FakeRepo repo = _FakeRepo(
        next: const DisplayPrefs(
          theme: DisplayTheme.dark,
          themeOpen: true,
        ),
      );
      final ThemeCubit cubit = ThemeCubit(repo);
      await cubit.load();
      repo.next = DisplayPrefs.closed;
      await cubit.load();
      expect(cubit.state.canChoose, isFalse);
      expect(cubit.state.themeMode, ThemeMode.light);
    });

    test('a closed switch ignores choose() and never writes', () async {
      final _FakeRepo repo = _FakeRepo();
      final ThemeCubit cubit = ThemeCubit(repo);
      await cubit.load();
      await cubit.choose(DisplayTheme.dark);
      expect(repo.writes, 0);
      expect(cubit.state.themeMode, ThemeMode.light);
    });

    test('an open switch writes the choice and applies it', () async {
      final _FakeRepo repo = _FakeRepo(
        next: const DisplayPrefs(
          theme: DisplayTheme.light,
          themeOpen: true,
        ),
      );
      final ThemeCubit cubit = ThemeCubit(repo);
      await cubit.load();
      await cubit.choose(DisplayTheme.dark);
      expect(repo.writes, 1);
      expect(repo.lastWritten, DisplayTheme.dark);
      expect(cubit.state.themeMode, ThemeMode.dark);
    });

    test('logout returns to Light and drops the cache', () async {
      final _FakeRepo repo = _FakeRepo(
        next: const DisplayPrefs(
          theme: DisplayTheme.dark,
          themeOpen: true,
        ),
      );
      final ThemeCubit cubit = ThemeCubit(repo);
      await cubit.load();
      cubit.onLogout();
      expect(repo.logouts, 1);
      expect(cubit.state.themeMode, ThemeMode.light);
      expect(cubit.state.canChoose, isFalse);
    });
  });
}
