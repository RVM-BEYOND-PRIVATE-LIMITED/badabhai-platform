import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/di/locator.dart';
import '../../../../core/error/failure.dart';
import '../../../profile_tab/domain/profile_summary.dart';
import '../../../profile_tab/domain/profile_summary_repository.dart';
import '../../../trade_form/domain/trade_form_models.dart' show TradeForm;
import '../../../trade_form/domain/trade_form_repository.dart';
import '../../domain/profile_repository.dart';

enum ProfileStatus {
  extracting,
  ready,
  failed,
  confirmed,
  draft,

  /// #1344 (scoped) — a confirmed profile that is checking, over the network,
  /// whether the worker's trade has a real trade form today before deciding
  /// where to route them. Brief and unobtrusive; see [ProfileCubit.confirm].
  routing,
}

/// #1344 (scoped retirement) — where a [ProfileStatus.confirmed] state routes
/// next. `tradeForm` when [TradeFormRepository.loadForm] returned a real form
/// for this worker's trade (server's `TRADE_FORM_KINDS`, growing over time);
/// `finishing` otherwise — including the network-check-failed fail-safe —
/// which is EXACTLY the single, unconditional destination this screen used
/// before this change. Only touch this file / the screen to widen coverage;
/// server-side trade-form coverage expanding requires zero further client
/// changes.
enum ProfileRouteTarget { tradeForm, finishing }

class ProfileState extends Equatable {
  const ProfileState({
    this.status = ProfileStatus.extracting,
    this.failure,
    this.summary,
    this.confirming = false,
    this.confirmFailure,
    this.routeTarget,
  });

  final ProfileStatus status;

  /// The typed cause when [status] is `failed` — the failed view surfaces its
  /// honest reason instead of a generic "check internet" line.
  final Failure? failure;

  /// The REAL extracted profile (trade / city / strength) read back from
  /// GET /workers/me/profile-summary, so the confirm step shows the worker
  /// their actual data — not a placeholder. `null` when the summary read
  /// missed (extraction still succeeded); the view then degrades honestly.
  final ProfileSummary? summary;

  /// True while `POST /profile/confirm` is in flight (#360). The CTA binds this
  /// so the worker sees the tap was registered — on 2G the request can run the
  /// full 15s timeout, and an unbound button looked simply dead.
  final bool confirming;

  /// The typed cause of a FAILED confirm (#360). Distinct from [failure], which
  /// belongs to the `failed` status: a confirm error keeps the worker on the
  /// READY view (their profile is intact and retryable), so it needs its own
  /// slot. Non-null for exactly one emission — the view announces it, and the
  /// next attempt clears it.
  final Failure? confirmFailure;

  /// #1344 (scoped) — set only once [status] reaches `confirmed`: which
  /// screen the listener routes to next. `null` at every other status.
  final ProfileRouteTarget? routeTarget;

  @override
  List<Object?> get props => <Object?>[
        status,
        failure,
        summary,
        confirming,
        confirmFailure,
        routeTarget,
      ];
}

/// Drives the profile-preview screen: run the async extraction on open, then
/// confirm on the worker's tap. Two sequential async actions, no streaming —
/// hence a Cubit.
///
/// #1344 (scoped) — the CUBIT, not the screen's `BlocListener`, owns the
/// post-confirm trade-form check: it is a network call with its own
/// loading→ready(ish)→route signal, exactly the shape `TradeFormCubit`/
/// `FinishingCubit` already establish for "network check then route" in this
/// codebase. The screen stays a pure function of state + one `context.go`.
class ProfileCubit extends Cubit<ProfileState> {
  ProfileCubit(
    this._repo,
    this._summaryRepo, {
    TradeFormRepository? tradeFormRepo,
  })  : _tradeFormRepo = tradeFormRepo,
        super(const ProfileState());

  final ProfileRepository _repo;
  final ProfileSummaryRepository _summaryRepo;

  /// Named + optional (mirrors `AccountDeleteCubit`/`ProfileTabCubit`): the
  /// existing two-positional-arg `ProfileCubit(repo, summaryRepo)` call site
  /// in `locator.dart` (#1341) keeps compiling untouched, and tests can still
  /// inject a fake without a wired DI graph.
  final TradeFormRepository? _tradeFormRepo;
  TradeFormRepository get _tradeForm =>
      _tradeFormRepo ?? locator<TradeFormRepository>();

  bool _confirming = false;

  Future<void> extract() async {
    emit(const ProfileState(status: ProfileStatus.extracting));
    try {
      await _repo.extractProfile();
      if (isClosed) return; // screen popped mid-extraction (the ~14s poll)
      // Read back the REAL extracted profile so the confirm step reflects the
      // worker's actual data. A summary-read miss is non-fatal — extraction
      // already succeeded — so the screen goes ready with a null summary and
      // the view degrades honestly (never a fabricated placeholder).
      ProfileSummary? summary;
      try {
        summary = await _summaryRepo.summary();
      } on Failure {
        summary = null;
      }
      if (isClosed) return;
      // TD81/#503: a content-poor or mock/AI-down extraction still COMPLETES the
      // job (real profile_id), but the row is stamped 'draft' — too little to be
      // a usable profile. Confirming it would generate a near-empty resume and
      // defeat the Phase-1 exit contract, so gate it here: a draft goes to its
      // own view (no Confirm CTA — back to chat to add detail) instead of ready.
      //
      // Only an EXPLICIT draft diverts. A summary-read MISS (null) still goes
      // ready, exactly as before — we cannot see the status, and extraction did
      // succeed, so we must not block on a signal we do not have.
      if (summary != null && summary.isDraft) {
        emit(ProfileState(status: ProfileStatus.draft, summary: summary));
      } else {
        emit(ProfileState(status: ProfileStatus.ready, summary: summary));
      }
    } on Failure catch (f) {
      if (isClosed) return;
      emit(ProfileState(status: ProfileStatus.failed, failure: f));
    }
  }

  Future<void> confirm() async {
    if (_confirming || state.status != ProfileStatus.ready) return;
    _confirming = true;
    // #360 — announce the in-flight request. Clears any previous confirmFailure
    // so a retry does not re-trigger the old error announcement.
    emit(ProfileState(
      status: ProfileStatus.ready,
      summary: state.summary,
      confirming: true,
    ));
    try {
      await _repo.confirmProfile();
      if (isClosed) return;
      // #1344 (scoped) — the confirm write landed; now decide WHERE to route,
      // which needs its own round trip. Announce it (routing) rather than
      // holding the worker on the prior frame with no signal at all — the
      // #360 lesson (an unbound wait at the last step reads as a dead app).
      emit(ProfileState(status: ProfileStatus.routing, summary: state.summary));
      final ProfileRouteTarget target = await _resolveRouteTarget();
      if (isClosed) return;
      emit(ProfileState(
        status: ProfileStatus.confirmed,
        summary: state.summary,
        routeTarget: target,
      ));
    } on Failure catch (failure) {
      if (isClosed) return;
      // #360 — this used to emit NOTHING ("no confirm-error affordance in the
      // frozen UI"), so a failed confirm on a weak link was indistinguishable
      // from a dead button: 15s of nothing, then still nothing. The worker taps
      // repeatedly and abandons at the FINAL step of the Phase-1 exit flow.
      // Stay on the ready view — the profile is intact and the retry is one tap
      // — but surface the real reason.
      emit(ProfileState(
        status: ProfileStatus.ready,
        summary: state.summary,
        confirmFailure: failure,
      ));
    } finally {
      _confirming = false;
    }
  }

  /// #1344 (scoped retirement ruling) — `null` from [TradeFormRepository.loadForm]
  /// is the clean, expected "this worker's trade has no form yet" (404) signal
  /// and means [ProfileRouteTarget.finishing], exactly the app's one prior
  /// destination. A non-null [TradeForm] means the opposite: this trade IS
  /// covered today, so route to it instead.
  ///
  /// EVERYTHING ELSE — a thrown [Failure], a timeout, any unexpected
  /// exception — is NOT a clean "no form" result and must never be read as
  /// one. This is a routing PRE-CHECK, not a user-facing operation the worker
  /// can retry from here; at the very last step of onboarding, ambiguity
  /// always resolves to the one path already proven to work, never to a
  /// stuck spinner or an error screen. Hence the bare `catch` below.
  Future<ProfileRouteTarget> _resolveRouteTarget() async {
    try {
      final TradeForm? form = await _tradeForm.loadForm();
      return form != null
          ? ProfileRouteTarget.tradeForm
          : ProfileRouteTarget.finishing;
    } catch (_) {
      return ProfileRouteTarget.finishing;
    }
  }
}
