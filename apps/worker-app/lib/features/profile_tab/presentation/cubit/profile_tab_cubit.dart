import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/api/api_client.dart';
import '../../../../core/di/locator.dart';
import '../../../../core/error/failure.dart';
import '../../../../core/session/session_repository.dart';
import '../../../auth/domain/auth_session_manager.dart';
import '../../domain/profile_summary.dart';
import '../../domain/profile_summary_repository.dart';

enum ProfileTabStatus { loading, ready, failed }

class ProfileTabState extends Equatable {
  const ProfileTabState({
    this.status = ProfileTabStatus.loading,
    this.summary,
    this.failure,
  });

  final ProfileTabStatus status;
  final ProfileSummary? summary;

  /// The typed cause when [status] is `failed` — the failed view surfaces its
  /// honest reason instead of a generic "check internet" line.
  final Failure? failure;

  @override
  List<Object?> get props => <Object?>[status, summary, failure];
}

/// Loads the tabbed Profile summary on open and owns the logout flow.
class ProfileTabCubit extends Cubit<ProfileTabState> {
  /// [api] and [session] are optional named seams so the existing DI
  /// registration `ProfileTabCubit(repo)` keeps compiling while tests can inject
  /// fakes for the logout flow. When omitted they are resolved LAZILY from the
  /// locator only inside [logout] — so constructing the cubit (e.g. the
  /// load-only unit tests) never requires a wired locator.
  ProfileTabCubit(
    this._repo, {
    ApiClient? api,
    SessionRepository? session,
  })  : _api = api,
        _session = session,
        super(const ProfileTabState());

  final ProfileSummaryRepository _repo;
  final ApiClient? _api;
  final SessionRepository? _session;

  /// True while a load is in flight — the tab-focus refetch must not stack a
  /// second one on top of the create:-time load.
  bool _loading = false;

  Future<void> load() async {
    if (_loading) return;
    _loading = true;
    emit(const ProfileTabState(status: ProfileTabStatus.loading));
    try {
      final ProfileSummary summary = await _repo.summary();
      if (isClosed) return;
      emit(ProfileTabState(status: ProfileTabStatus.ready, summary: summary));
    } on Failure catch (f) {
      if (isClosed) return;
      emit(ProfileTabState(status: ProfileTabStatus.failed, failure: f));
    } finally {
      _loading = false;
    }
  }

  /// Tab-focus refetch (T4). No spinner and no wipe: the worker is looking at
  /// their profile, and a blip on a background refetch must not replace it with
  /// a loading state or an error view. Failure is only surfaced when there was
  /// nothing good on screen already.
  Future<void> refresh() async {
    if (_loading) return;
    _loading = true;
    try {
      final ProfileSummary summary = await _repo.summary();
      if (isClosed) return;
      emit(ProfileTabState(status: ProfileTabStatus.ready, summary: summary));
    } on Failure catch (f) {
      if (isClosed) return;
      if (state.status != ProfileTabStatus.ready) {
        emit(ProfileTabState(status: ProfileTabStatus.failed, failure: f));
      }
    } finally {
      _loading = false;
    }
  }

  /// Best-effort logout: revoke the token server-side (ignored on failure —
  /// offline-safe), then wipe the session. The screen handles navigation back to
  /// the login route after this resolves.
  ///
  /// When persistent auth is wired (the real app), it delegates to
  /// [AuthSessionManager.logout] — which ALSO clears the secure store (refresh
  /// token + worker id) and flips the auth status to loggedOut so the router
  /// redirect bounces to /login. The legacy [ApiClient]/[SessionRepository] path
  /// is the fallback for the existing unit tests that inject those seams without
  /// a manager.
  Future<void> logout() async {
    if (_api == null &&
        _session == null &&
        locator.isRegistered<AuthSessionManager>()) {
      await locator<AuthSessionManager>().logout();
      return;
    }
    final ApiClient api = _api ?? locator<ApiClient>();
    final SessionRepository session = _session ?? locator<SessionRepository>();
    final String? token = session.sessionToken;
    try {
      if (token != null && token.isNotEmpty) {
        await api.logout(authToken: token);
      }
    } catch (_) {
      // Ignore: a failed/offline revoke must not block local sign-out.
    }
    session.clear();
  }
}
