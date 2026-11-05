import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../core/di/locator.dart';
import '../../../core/observability/crash_reporter.dart';
import '../../../core/session/app_session.dart';
import '../../../core/session/app_session_cubit.dart';
import '../../../core/session/credits_cubit.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_motion.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_system_ui.dart';
import '../../../core/widgets/bb_bottom_nav.dart';
import '../../../core/widgets/bb_leave_guard.dart';
import '../../../core/widgets/bb_new_item_highlight.dart';
import '../../../core/widgets/bb_overlay_host.dart';
import '../../../core/widgets/bb_tab_scope.dart';
import '../../credits/presentation/credits_screen.dart';
import '../../find/presentation/find_screen.dart';
import '../../find/presentation/reveal_args.dart';
import '../../find/presentation/reveal_screen.dart';
import '../../home/presentation/home_screen.dart';
import '../../job_posting_chat/presentation/job_posting_chat_screen.dart';
import '../../jobs/presentation/jobs_screen.dart';
import '../../jobs/presentation/post_job_screen.dart';
import '../../account/presentation/account_screen.dart';
import '../../referral/presentation/referral_screen.dart';

/// The signed-in shell. Holds the bottom nav and an in-shell navigation model
/// mirroring the kit: a primary [_tab] (a nav destination) and an optional
/// [_sub] overlay (Post / Credits / Reveal) pushed above it with a back
/// affordance. The credit balance is loaded once here and shared app-wide.
///
/// The agency-only Earn tab (hub · referral · referred workers · payouts · KYC)
/// was REMOVED: none of those surfaces had a backend route, so every figure was
/// invented, and the KYC form collected real PAN/bank details that were then
/// discarded behind a fake "in review". Both roles now share the same tabs;
/// `Credits` is real (`GET /payer/credits`) for a company and an agency alike.
class AppShell extends StatefulWidget {
  const AppShell({super.key, required this.session});

  final AppSession session;

  /// The full-bleed blue strip behind the status bar on a bare Home (#2590).
  @visibleForTesting
  static const Key statusBarStripKey = Key('app_shell_status_bar_strip');

  @override
  State<AppShell> createState() => _AppShellState();
}

class _AppShellState extends State<AppShell> {
  String _tab = 'home';
  String? _sub;
  RevealArgs? _revealed;

  /// The chat session the 'aiPost' overlay should RESUME (ADR-0035 cross-device
  /// pickup), or null to start a fresh conversation. Cleared on [_back] so the
  /// next open does not silently reopen a finished chat.
  String? _resumeChatId;

  /// #2592 — bumped by a Jobs card's "Applicants" button: Find rebuilds just
  /// its Applicants view on a fresh cubit (a fresh feed). The rest of Find —
  /// the All-candidates filters, loaded pages and scroll — is kept, and
  /// re-reads quietly when the payer opens it again. No tab branch is ever
  /// rebuilt now: a return re-reads it in place ([_signals]).
  int _applicantsEpoch = 0;

  /// #2592 — per-tab signals: a return to a tab asks its screens to re-read
  /// their API QUIETLY, the data on screen staying put until the fresh rows
  /// land (no skeleton, no spinner — "latest on every return" without the wait).
  final Map<String, BbTabSignals> _signals = <String, BbTabSignals>{};

  BbTabSignals _signalsOf(String id) =>
      _signals.putIfAbsent(id, BbTabSignals.new);

  /// #2592 — each tab's lists attach to that tab's own primary scroll
  /// controller, so re-tapping the tab on screen scrolls it (and only it) back
  /// to the top. The overlay gets its own, and the Scaffold reads whichever is
  /// on screen (the iOS status-bar tap).
  final Map<String, ScrollController> _scrolls = <String, ScrollController>{};
  final ScrollController _overlayScroll = ScrollController();

  ScrollController _scrollOf(String id) =>
      _scrolls.putIfAbsent(id, ScrollController.new);

  /// #2591 — bumped on every overlay open. The overlay animates OUT for
  /// the page duration; keying each open on its own epoch guarantees a reopen
  /// inside that window still mounts a fresh screen (a blank Post form).
  int _overlayEpoch = 0;

  /// #382 — the tabs the payer has actually opened. The branches live in an
  /// [IndexedStack] so leaving a tab HIDES it instead of disposing it, but a
  /// never-visited tab stays an empty placeholder: mounting all five eagerly
  /// would fire every tab's `load()` on cold start (Find alone costs
  /// `GET /payer/job-postings` + `GET /payer/reach/jobs/:id/applicants`) for
  /// surfaces the payer may never open. Grows to at most five entries.
  final Set<String> _visited = <String>{'home'};

  /// The view a Find visit opens on: All candidates (owner rulings
  /// 2026-11-03) unless a Jobs card's "Applicants" button opened it. A first
  /// visit mounts Find on it; a return hands it to the Find already mounted,
  /// which switches to it when the return's refresh signal arrives.
  FindView _findView = FindView.allCandidates;

  /// The posting whose "Applicants" button opened Find (#2593), so the
  /// Applicants view opens on THAT job. Null on every other Find visit.
  String? _findJobId;

  /// #2595 — the open overlay's unsaved-changes guard (Post, the AI chat): the
  /// shell asks it before its own system Back or a nav tap leaves the overlay.
  final BbLeaveGuardController _leaveGuard = BbLeaveGuardController();

  /// #2595 — overlays that are full-screen TASKS with their own pinned bar:
  /// the app's bottom nav hides under them (it stacked as a second bar under
  /// Post's action bar and the AI chat's composer). Leaving one is its back
  /// arrow or the system Back, which its leave guard asks about; a nav tap
  /// that leaves any other overlay still goes through the guard
  /// ([_onNavSelect]).
  static const Set<String> _fullScreenTasks = <String>{'post', 'aiPost'};

  /// #2596 — the posting the payer just created, for Jobs to scroll to and
  /// tint. One-shot ([BbHighlightRequest.claim]), so a later visit to Jobs —
  /// which re-reads the list in place (#2592) — never replays it. It also belongs to the
  /// LANDING visit only: every tab switch or overlay open drops it, so a
  /// request no row claimed (the list failed, or the payer left before it
  /// loaded) can never tint a card minutes later.
  BbHighlightRequest? _justPosted;

  @override
  void initState() {
    super.initState();
    locator<CreditsCubit>().load();
    CrashReporter.setScreen('payer/$_tab'); // seed the shell's initial screen
  }

  @override
  void dispose() {
    for (final BbTabSignals s in _signals.values) {
      s.dispose();
    }
    for (final ScrollController c in _scrolls.values) {
      c.dispose();
    }
    _overlayScroll.dispose();
    super.dispose();
  }

  static const List<BbNavTab> _tabs = <BbNavTab>[
    BbNavTab(
      id: 'home',
      label: 'Home',
      iconInactive: Icons.home_rounded,
      iconActive: Icons.home_rounded,
    ),
    BbNavTab(
      id: 'find',
      label: 'Find',
      iconInactive: Icons.search_rounded,
      iconActive: Icons.search_rounded,
    ),
    BbNavTab(
      id: 'jobs',
      label: 'Jobs',
      iconInactive: Icons.work_rounded,
      iconActive: Icons.work_rounded,
    ),
    BbNavTab(
      id: 'credits',
      label: 'Credits',
      iconInactive: Icons.lock_open_rounded,
      iconActive: Icons.lock_open_rounded,
    ),
    BbNavTab(
      id: 'account',
      label: 'Account',
      iconInactive: Icons.person_rounded,
      iconActive: Icons.person_rounded,
    ),
  ];

  /// [findView] picks the view a Find visit opens on; every other caller (the
  /// nav, Home's Browse) gets the default, All candidates. [findJobId] is the
  /// job a Jobs card's "Applicants" was tapped on (#2593).
  void _selectTab(
    String id, {
    FindView findView = FindView.allCandidates,
    String? findJobId,
  }) {
    _leaveGuard.release();
    // A Jobs card's "Applicants" button lands Find on that view, on a fresh
    // feed ([_applicantsEpoch]).
    final bool applicantsLink =
        id == 'find' && findView == FindView.applicants;
    // #2592 — re-tapping the tab already on screen scrolls it to the top; it
    // does not reload it. (Find still hears the re-tap: the nav tab opens All
    // candidates even from the Applicants view a Jobs card opened.)
    if (id == _tab && _sub == null && !applicantsLink) {
      setState(() => _findView = findView);
      _scrollToTop(id);
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _signalsOf(id).reselect();
      });
      return;
    }
    final bool revisit = _visited.contains(id);
    setState(() {
      _justPosted = null;
      _tab = id;
      _sub = null;
      _findView = findView;
      _findJobId = findJobId;
      _visited.add(id);
      if (applicantsLink) _applicantsEpoch++;
      CrashReporter.setScreen('payer/$id');
    });
    // #2592 — every return re-reads the screen's API, QUIETLY: the branch keeps
    // its cubits, rows, filters and scroll, and the fresh data replaces them in
    // place. A first visit mounts the branch, whose cubits load. Sent after
    // this frame, so the branch already holds its new configuration (Find's
    // requested view) when it hears it.
    if (revisit) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _signalsOf(id).refresh();
      });
    }
    // Home/Find/Credits all read the shared balance; refresh it with the tab.
    locator<CreditsCubit>().load();
  }

  /// Scrolls every list of tab [id] back to the top — instantly under reduced
  /// motion.
  void _scrollToTop(String id) {
    final ScrollController scroll = _scrollOf(id);
    if (!scroll.hasClients) return;
    final Duration duration = AppMotion.resolve(context, AppMotion.page);
    if (duration == Duration.zero) {
      scroll.jumpTo(0);
    } else {
      scroll.animateTo(0, duration: duration, curve: AppMotion.easeOut);
    }
  }

  void _openSub(String id) => setState(() {
        _justPosted = null;
        _overlayEpoch++;
        _sub = id;
        CrashReporter.setScreen('payer/$id');
      });

  /// A bottom-nav tap. With an overlay open it LEAVES that overlay, so one
  /// holding unsaved input asks first (#2595).
  void _onNavSelect(String id) {
    if (_sub == null) {
      _selectTab(id);
    } else {
      _leaveGuard.leaveThen(() => _selectTab(id));
    }
  }

  void _back() => setState(() {
        _leaveGuard.release();
        _sub = null;
        _revealed = null;
        _resumeChatId = null;
        CrashReporter.setScreen('payer/$_tab');
      });

  /// Opens the AI job-posting chat (ADR-0035). A non-null [resumeSessionId]
  /// picks an existing conversation back up — the mobile half of cross-device
  /// resume; null starts a new one.
  void _openAiPost(String? resumeSessionId) => setState(() {
        _justPosted = null;
        _overlayEpoch++;
        _resumeChatId = resumeSessionId;
        _sub = 'aiPost';
        CrashReporter.setScreen('payer/aiPost');
      });

  /// After a post (the form or the AI chat): close the overlay and land on
  /// Jobs — the list re-reads (quietly on a return, #2592) — with the new card
  /// scrolled into view and highlighted (#2596). [_selectTab] releases the
  /// overlay's leave guard (a just-posted form never asks) and drops any older
  /// request; the new one is set after it, for this visit only.
  void _landOnPostedJob(String postingId) {
    _selectTab('jobs');
    // #2592 — My jobs keeps its scroll across visits, but the server lists
    // postings newest first, so the new card is at the TOP. A lazy list left
    // scrolled down would never build that row, and an unbuilt row never
    // claims the highlight or scrolls into view. Jump (no motion; the
    // overlay still covers the list), for the company and agency list alike.
    // A first visit mounts at the top and has no clients yet.
    final ScrollController jobs = _scrollOf('jobs');
    if (jobs.hasClients) jobs.jumpTo(0);
    setState(() {
      _resumeChatId = null;
      _justPosted = BbHighlightRequest(postingId);
    });
  }

  void _openReveal(RevealArgs args) => setState(() {
        _justPosted = null;
        _overlayEpoch++;
        _revealed = args;
        _sub = 'reveal';
        CrashReporter.setScreen('payer/reveal');
      });

  /// #2592 — Post closed without [_landOnPostedJob] (its back arrow, or a
  /// hand-back that carries no posting id): back on My jobs, the list
  /// re-reads quietly, since re-tapping the tab no longer reloads it. Any
  /// other tab re-reads Jobs when the payer goes there.
  void _closePost() {
    _back();
    if (_tab == 'jobs') _signalsOf('jobs').refresh();
  }

  /// Opens the agency supply hub (Refer & earn) as a full-page route — the same
  /// agent-only surface the Account entry pushes. A real route (not an in-shell
  /// overlay) so Android back pops it normally. Only wired for an agency session.
  void _openReferral() {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        settings: const RouteSettings(name: 'payer/agency/referral'),
        builder: (_) => const ReferralScreen(),
      ),
    );
  }

  /// One tab branch, or an empty placeholder until that tab has been visited
  /// (see [_visited]). Every branch here builds its own `BlocProvider`, so what
  /// this returns is exactly what the IndexedStack keeps alive.
  Widget _tabBody(String id) {
    if (!_visited.contains(id)) return const SizedBox.shrink();
    // #2592 — the branch mounts once and is never rebuilt: its cubits load on
    // the first visit, and each return re-reads them quietly through the
    // tab's signals. Re-tapping the tab scrolls its own primary controller.
    return BbTabScope(
      signals: _signalsOf(id),
      child: PrimaryScrollController(
        controller: _scrollOf(id),
        // #2590 — Home draws its blue identity header BEHIND the status bar
        // (it pads itself by the top inset); every other branch keeps the top
        // inset.
        child: id == 'home'
            ? _tabScreen(id)
            : SafeArea(bottom: false, child: _tabScreen(id)),
      ),
    );
  }

  Widget _tabScreen(String id) {
    return switch (id) {
      'home' => HomeScreen(
          session: widget.session,
          onPost: () => _openSub('post'),
          onBrowse: () => _selectTab('find'),
          onOpenCredits: () => _selectTab('credits'),
          // Agency-only: the Home supply hub. Null for a company session, so the
          // Home agency section never renders for a company.
          onOpenReferral: widget.session.isAgency ? _openReferral : null,
        ),
      'find' => FindScreen(
          onReveal: _openReveal,
          initialView: _findView,
          initialJobId: _findJobId,
          applicantsEpoch: _applicantsEpoch,
        ),
      'jobs' => JobsScreen(
          onPost: () => _openSub('post'),
          onAiPost: _openAiPost,
          // Both session kinds see their candidates on the shared Find tab —
          // a job card's "Applicants" button lands on the Applicants view, on
          // the job that was tapped (#2593; it used to open the first one).
          onApplicants: (String? jobId) => _selectTab(
            'find',
            findView: FindView.applicants,
            findJobId: jobId,
          ),
          highlight: _justPosted,
        ),
      // M9 (#2597): a tab root has no back arrow; the bottom nav is the way
      // out. The pushed Credits overlay below keeps its back.
      'credits' => const CreditsScreen(),
      'account' => AccountScreen(
          session: widget.session,
          onSignOut: () => context.read<AppSessionCubit>().signOut(),
        ),
      _ => const SizedBox.shrink(),
    };
  }

  Widget _buildBody() {
    // #382 — the branches live in an IndexedStack, so leaving a tab hides it
    // instead of tearing it down; hidden tabs keep their state. #2592 —
    // latest-on-switch is QUIET: a return to a tab sends that tab's
    // [BbTabSignals.refresh] and its screens re-read in place, the old rows
    // staying on screen until the fresh ones land. A Jobs card's "Applicants"
    // button rebuilds only Find's Applicants view ([_applicantsEpoch]).
    final String? sub = _sub;
    final int tabIndex = _tabs.indexWhere((BbNavTab t) => t.id == _tab);
    final Widget tabs = IndexedStack(
      // An unknown tab id falls back to the first branch — the old switch's
      // SizedBox default, minus the risk of an out-of-range stack index.
      index: tabIndex < 0 ? 0 : tabIndex,
      // The body was previously the Scaffold's full-bleed child; the default
      // loose sizing would shrink-wrap it, so keep the tight fill.
      sizing: StackFit.expand,
      children: <Widget>[
        for (final BbNavTab tab in _tabs) _tabBody(tab.id),
      ],
    );
    // #2591 — the overlay sits ABOVE the tabs in a [BbOverlayHost], which
    // animates it in and out (it used to hard-cut as an IndexedStack slot) and
    // keeps the tabs mounted-but-offstage while it covers them. Unlike a tab
    // the overlay is deliberately rebuilt from scratch on open/dismiss: Post
    // must open on a blank form, and Reveal is bound to the [RevealArgs] of
    // the card that opened it.
    final Widget host = BbOverlayHost(
      base: tabs,
      overlay: sub == null
          ? null
          : SafeArea(
              key: ValueKey<int>(_overlayEpoch),
              bottom: false,
              child: switch (sub) {
                'post' =>
                  PostJobScreen(onBack: _closePost, onPosted: _landOnPostedJob),
                'aiPost' => JobPostingChatScreen(
                    // A fresh chat and a resumed one are different
                    // conversations — key on the session so reopening never
                    // reuses the old bloc.
                    key: ValueKey<String>('aiPost:${_resumeChatId ?? 'new'}'),
                    onBack: _back,
                    resumeSessionId: _resumeChatId,
                    // #2592 — a quiet re-read: the new posting joins the list
                    // without the Jobs tab blanking behind a skeleton.
                    onPublished: () => _signalsOf('jobs').refresh(),
                    onPostedJob: _landOnPostedJob,
                  ),
                'credits' => CreditsScreen(onBack: _back),
                'reveal' => RevealScreen(args: _revealed!, onBack: _back),
                _ => const SizedBox.shrink(),
              },
            ),
    );
    // #2592 — the overlay's lists scroll on [_overlayScroll]; every tab branch
    // inside overrides it with its own (see _tabBody).
    final Widget stack =
        PrimaryScrollController(controller: _overlayScroll, child: host);
    // #1087 — cap the content column on tablets/foldables so it never stretches
    // to an unreadable line length. The page background stays full-bleed (the
    // Scaffold canvas shows outside the cap); only the content is centred.
    final Widget capped = Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: AppSpacing.appMax),
        // #2595 — the open overlay's leave guard registers here (a tab never
        // carries one; the shell only asks while an overlay is open).
        child: BbLeaveGuardScope(controller: _leaveGuard, child: stack),
      ),
    );
    // #2590 — Home's blue header runs under the status bar and asks for light
    // icons, but the column is capped at appMax. On a wider screen the bar
    // corners (clock, battery) would show the light canvas, so a full-bleed
    // blue strip of the status-bar height sits behind the capped column. The
    // Stack is always present (only the strip toggles) so switching tabs never
    // reparents — and so never remounts — the IndexedStack branches (#382).
    final bool bareHome = sub == null && _tab == 'home';
    return Stack(
      children: <Widget>[
        Positioned(
          top: 0,
          left: 0,
          right: 0,
          height: MediaQuery.paddingOf(context).top,
          child: bareHome
              ? const ColoredBox(
                  key: AppShell.statusBarStripKey,
                  color: AppColors.blue,
                )
              : const SizedBox.shrink(),
        ),
        capped,
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    // #2592 — the Scaffold's own primary controller (the iOS status-bar tap)
    // is the one on screen: the current tab's, or the overlay's.
    return PrimaryScrollController(
      controller: _sub == null ? _scrollOf(_tab) : _overlayScroll,
      child: _scaffold(context),
    );
  }

  Widget _scaffold(BuildContext context) {
    // The active nav id stays highlighted while a sub-overlay is open if the
    // overlay belongs to that tab; default to the current tab otherwise.
    final String navId = _tab;
    // #359 — the tab and the Post/Credits/Reveal overlays are setState state,
    // NOT Navigator routes, so the Android system back used to reach the
    // shell's root route unopposed and finish the activity: a half-filled
    // Post-a-job form (11 controllers of typed input) was lost on the primary
    // Android affordance, with only the small in-screen arrow doing the right
    // thing. Back now unwinds the in-shell stack the way the payer built it —
    // overlay first, then a non-home tab back to Home — and only bubbles out
    // (exiting the app) from a bare Home, which is the shell's true root.
    // Routes pushed above the shell (Disclosure history, dialogs) are real
    // routes and pop normally; this PopScope belongs to the shell's route and
    // never sees their back presses.
    return PopScope<Object?>(
      canPop: _sub == null && _tab == 'home',
      onPopInvokedWithResult: (bool didPop, Object? result) {
        if (didPop) return;
        if (_sub != null) {
          // #2595 — an overlay holding unsaved input asks before it goes.
          _leaveGuard.leaveThen(_back);
        } else if (_tab != 'home') {
          _selectTab('home');
        }
      },
      child: Scaffold(
        backgroundColor: AppColors.surfacePage,
        // #2590 — the top inset is applied per branch (see _tabBody) so Home's
        // header can run under the status bar; the canvas gets dark icons.
        body: AnnotatedRegion<SystemUiOverlayStyle>(
          value: AppSystemUi.onLight,
          child: SafeArea(top: false, bottom: false, child: _buildBody()),
        ),
        bottomNavigationBar: _fullScreenTasks.contains(_sub)
            ? null
            : BbBottomNav(
                tabs: _tabs,
                currentId: navId,
                onSelect: _onNavSelect,
              ),
      ),
    );
  }
}
