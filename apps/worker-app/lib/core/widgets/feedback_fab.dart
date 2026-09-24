import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../features/auth/domain/auth_session_manager.dart';
import '../../router.dart';
import '../di/locator.dart';
import '../theme/app_spacing.dart';
import '../theme/onboarding_theme.dart';
import 'bottom_bar_inset.dart';

/// Route paths where the floating Feedback button is HIDDEN, matched EXACTLY so
/// a prefix rule can't swallow the whole app:
///  - the SPLASH, and
///  - the three TAB ROOTS. Their `KitTabHeader` carries the Feedback glyph
///    itself (spec §4), so the floating pill would be a second, identical
///    action on the same screen — and it is the one that sits over the bottom
///    nav. Matched exactly, so the pushed routes UNDER a tab (`/resume/edit`,
///    `/jobs/search`, `/profile/settings`) keep the pill: those screens have no
///    header Feedback action of their own.
///
/// "Matched exactly" only holds because the overlay resolves the TOP-MOST route
/// rather than the shell's location — see [_FeedbackFabOverlayState._currentPath].
const List<String> _kHiddenExactPaths = <String>[
  '/', // splash
  Routes.jobs, // /jobs — tab header owns Feedback
  Routes.resume, // /resume — tab header owns Feedback
  Routes.profile, // /profile — tab header owns Feedback
];

/// Route path PREFIXES where the button is hidden. Kept to the MINIMUM:
///  - the FEEDBACK page itself — else tapping it stacks /feedback on /feedback
///    forever (the reported infinite-stack bug), and
///  - the PRE-LOGIN screens (login / OTP / PIN) — feedback is worker-authed, so
///    with no session token there yet a tap would only 401; a dead button is
///    worse than no button, and
///  - the two `ChatProfilingScreen` routes (onboarding chat + Bada Bhai tab) —
///    that screen puts its own Feedback action in the header instead, so the
///    floating one would double up, and
///  - the name onboarding step — its docked bottom bar carries its own Feedback
///    pill beside Continue, for the same reason, and
///  - the BUILDING screen — the resume is being generated and the spec gives
///    that screen no feedback button: the worker is meant to watch one thing
///    finish, and
///  - the VOICE note screen, where the pill would sit over the record control
///    on a small handset, and
///  - the PROFILE PREVIEW / preparing screen — its Shift Blue header carries
///    the Feedback WORD ([KitFeedbackTextAction]) in the slot the brand lockup
///    used to hold, so the pill would be the second one again.
/// Everywhere else the worker is logged in (including consent onboarding) shows
/// it.
const List<String> _kHiddenPrefixes = <String>[
  Routes.phoneLogin, // /login
  Routes.otpVerify, // /otp
  Routes.pin, // /pin (covers /pin/set, /pin/forgot) — locked, no session token
  Routes.feedback, // don't offer feedback from the feedback page (anti-stack)
  Routes.chatProfiling, // /chat — header owns Feedback here instead
  Routes.badaBhai, // /bada-bhai — same screen, same reason
  Routes.name, // /name — the bottom bar owns a Feedback pill here instead
  Routes.building, // /building — spec §3.22 gives it no feedback button
  Routes.voiceNote, // /voice — would cover the record control at 320dp
  Routes.profilePreview, // /profiling — header owns the Feedback word instead
];

/// Whether the floating Feedback button should show on [path].
///
/// [consentAccepted] is the router's TRI-STATE consent signal, and ONLY when the
/// gate is live (see [feedbackConsentSignal]) — otherwise null.
///
/// RULING — a DEFINITIVE `false` hides the button EVERYWHERE. Settled; do not
/// re-open it as "the worker should still be able to send feedback". Two reasons,
/// and the first one is the binding one:
///
///  1. LAWFULNESS. Pre-consent there is nothing this screen could do with the
///     worker's free text. §6's `ConsentGuard` refuses the submit server-side,
///     and storing or transmitting a worker's own words before they have
///     consented is not lawful processing under DPDP. A button whose only
///     possible outcome is an unlawful write or a refusal is not a feature.
///  2. It would be DEAD. `_authRedirect` (`router.dart`) bounces any push to
///     `/feedback` straight back to `/consent` while consent is false, so the
///     worker taps Feedback and NOTHING VISIBLY HAPPENS AT ALL: no screen, no
///     error, no explanation — and a dead button is worse than no button, the
///     same rule the rest of this file already states. (In that state /consent is
///     the only reachable route anyway, so this hides the button on exactly one
///     screen — the one where it is dead.)
///
/// `null` — the tri-state unknown, i.e. an older server that never sent the field
/// — deliberately still SHOWS it: the worker may well have consented, the push
/// is not redirected, and the screen handles the server's own 403 with something
/// they can act on. Hiding on unknown would delete feedback for every worker on
/// an older API to avoid an error that may never come.
bool showFeedbackOn(String path, {bool? consentAccepted}) {
  if (consentAccepted == false) return false;
  for (final String p in _kHiddenExactPaths) {
    if (path == p) return false;
  }
  for (final String p in _kHiddenPrefixes) {
    if (path == p || path.startsWith('$p/')) return false;
  }
  return true;
}

/// The consent signal to hand [showFeedbackOn], read off [auth] — or null when
/// the router's consent gate is not live and so cannot swallow the push.
///
/// It is live only under the exact conditions `_authRedirect` requires before it
/// will redirect at all: the auth graph is wired, [AuthSessionManager.bootstrap]
/// has resolved, persistent-auth is ON, and the worker is authenticated. Any
/// other state and the redirect returns null (or routes on status, to a screen
/// where the button is already hidden by path), so the button is left alone.
bool? feedbackConsentSignal(AuthSessionManager? auth) {
  if (auth == null || !auth.isReady || !auth.persistentAuthEnabled) return null;
  if (auth.status != AuthStatus.authenticated) return null;
  return auth.consentAccepted;
}

/// Distance the button floats ABOVE the safe-area bottom — enough to clear the
/// bottom nav on the tab pages so it never covers a nav item. On full-screen
/// pages it simply floats a little higher, consistently. It is a FLOOR: a page
/// whose own bottom bar is TALLER than this (a sticky CTA) pushes the button
/// higher still, via [bottomBarInset] (#1071).
const double _kBottomInset = 72;

/// The pill's own painted height. It is [OnboardingLayout.tapTarget] because
/// the pill clamps its text scaling to the chrome ceiling, so its content never
/// exceeds the 48dp floor its own `ConstrainedBox` sets.
const double _kPillHeight = OnboardingLayout.tapTarget;

/// A little air between the pill and the content above it, so the reserved band
/// does not end flush against a line of text.
const double _kPillClearance = 8;

/// The height of the band the floating Feedback pill occupies, measured ABOVE a
/// page's own bottom bar — 0 when the pill is not shown on this route.
///
/// This is what stops the pill sitting ON TOP of real content. It floats above
/// the Navigator, so no page's `Scaffold` can lay out around it; a scrolling
/// body instead READS this and adds it to its bottom padding, which turns the
/// pill's band into empty canvas the way a docked bar's own height already
/// does. Without it the pill covered the DPDP consent tick — and because the
/// tick is the LAST child of that scroll view, it could not be scrolled clear,
/// so a tap landed on the pill, pushed /feedback, and onboarding dead-ended
/// with 'Aage Badhein' permanently disabled. It also covered a finishing page's
/// fourth option, the invite CTA, and the tail of a dozen other pages.
///
/// An [InheritedWidget] rather than another [ValueNotifier], so a page picks
/// the value up by reading it and only the pages that read it rebuild when it
/// changes.
class FeedbackFabInset extends InheritedWidget {
  const FeedbackFabInset({
    super.key,
    required this.reserve,
    required super.child,
  });

  /// Logical pixels to add to a scroll view's BOTTOM padding.
  final double reserve;

  /// The reserve for [context], or 0 where no overlay is mounted (every
  /// isolated widget test, and any host that does not install the pill).
  static double of(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<FeedbackFabInset>()?.reserve ??
      0;

  @override
  bool updateShouldNotify(FeedbackFabInset oldWidget) =>
      oldWidget.reserve != reserve;
}

/// Overlays a FIXED bottom-LEFT "Feedback" button on every non-auth page (CEO
/// request). Lives ONCE in the MaterialApp builder — above the router's Navigator
/// and the bottom nav — so a single instance covers the whole app instead of
/// each screen re-adding one. Steps out of the way while the keyboard is open so
/// it never sits over a composer.
///
/// ROUTE SOURCE: it tracks `router.routerDelegate.currentConfiguration` — the
/// RESOLVED match list, which updates on every navigation INCLUDING a
/// refreshListenable redirect (login → Resume). `routeInformationProvider.value`
/// LAGS such a redirect, which is why the button used to be missing on the first
/// post-login landing until a manual tab switch. But the delegate can notify
/// mid-build (a redirect resolving inside a frame), so the rebuild is DEFERRED to
/// the next frame — rebuilding synchronously on it throws a `!_dirty` assertion.
class FeedbackFabOverlay extends StatefulWidget {
  const FeedbackFabOverlay({
    super.key,
    required this.router,
    required this.child,
  });

  final GoRouter router;
  final Widget child;

  @override
  State<FeedbackFabOverlay> createState() => _FeedbackFabOverlayState();
}

class _FeedbackFabOverlayState extends State<FeedbackFabOverlay> {
  /// The auth manager when the graph is wired; null under the legacy widget
  /// tests that pump the app without `initAuthLocator` — in which case the
  /// consent gate is inert and the button behaves exactly as it always did.
  AuthSessionManager? _auth;

  late String _path = _currentPath();
  late bool? _consentAccepted = feedbackConsentSignal(_auth);
  bool _scheduled = false;

  @override
  void initState() {
    super.initState();
    _auth = locator.isRegistered<AuthSessionManager>()
        ? locator<AuthSessionManager>()
        : null;
    _consentAccepted = feedbackConsentSignal(_auth);
    widget.router.routerDelegate.addListener(_onNavigation);
    // Consent can flip WITHOUT the path changing (`markConsentAccepted` on a
    // successful submit), and the button has to come back when it does.
    _auth?.addListener(_onNavigation);
  }

  @override
  void didUpdateWidget(FeedbackFabOverlay oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.router != widget.router) {
      oldWidget.router.routerDelegate.removeListener(_onNavigation);
      widget.router.routerDelegate.addListener(_onNavigation);
      _path = _currentPath();
    }
  }

  @override
  void dispose() {
    widget.router.routerDelegate.removeListener(_onNavigation);
    _auth?.removeListener(_onNavigation);
    super.dispose();
  }

  /// The path of the screen the worker is actually LOOKING AT.
  ///
  /// The TOP-MOST match, not `currentConfiguration.uri` — and the difference is
  /// the whole reason this method exists. `uri` reflects only the routes reached
  /// by `go`: an IMPERATIVE `push` renders a new screen WITHOUT changing it, so
  /// pushing `/resume/edit` leaves `uri.path` reading `/resume`. Judging the
  /// pill on `uri.path` therefore judged every pushed screen by the tab root it
  /// was pushed from — and since the tab roots are hidden (R2, their header owns
  /// Feedback), that silently stripped the pill from `/resume/edit`,
  /// `/profile/settings`, `/jobs/search`, `/jobs/detail/*`, `/devices` and
  /// `/alerts`, none of which has a header Feedback action of its own.
  ///
  /// `lastOrNull` is the last LEAF match, which is the route on top of the
  /// stack whether it arrived by `push`, `go` or a `pop` back to it, and it is
  /// still read off the RESOLVED configuration — so the redirect tracking this
  /// source was chosen for is untouched. It also makes the `/feedback`
  /// anti-stack prefix work for a PUSHED /feedback, which is how it is opened.
  String _currentPath() {
    final RouteMatchList config =
        widget.router.routerDelegate.currentConfiguration;
    final String p = config.lastOrNull?.matchedLocation ?? config.uri.path;
    return p.isEmpty ? '/' : p;
  }

  /// The delegate can fire DURING a build (a redirect resolving inside the frame),
  /// so never setState synchronously here — defer to after the frame. Coalesced
  /// by [_scheduled] so a burst of notifications schedules one rebuild.
  void _onNavigation() {
    if (_scheduled) return;
    _scheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _scheduled = false;
      if (!mounted) return;
      final String p = _currentPath();
      final bool? consent = feedbackConsentSignal(_auth);
      if (p != _path || consent != _consentAccepted) {
        setState(() {
          _path = p;
          _consentAccepted = consent;
        });
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final bool keyboardOpen = MediaQuery.of(context).viewInsets.bottom > 0;
    final double safeBottom = MediaQuery.of(context).padding.bottom;
    final bool visible =
        showFeedbackOn(_path, consentAccepted: _consentAccepted) &&
        !keyboardOpen;
    // The builder wraps the WHOLE subtree, because the reserve it computes has
    // to reach the PAGE as well as the pill. That costs nothing: `widget.child`
    // is the same Widget instance on every rebuild, so the router subtree
    // short-circuits in `Element.updateChild` and only the pages that actually
    // read [FeedbackFabInset] rebuild when the number changes.
    return ValueListenableBuilder<double>(
      valueListenable: bottomBarInset,
      builder: (BuildContext context, double barHeight, _) {
        // Float above whichever is taller: the default inset (which clears the
        // bottom nav) or the current page's real bottom bar (#1071).
        final double float = math.max(_kBottomInset, barHeight);
        return FeedbackFabInset(
          // What the pill occupies ABOVE the page's own bottom bar. The bar
          // sits outside the body already, so its height is subtracted.
          reserve: visible
              ? math.max(0, float + _kPillHeight + _kPillClearance - barHeight)
              : 0,
          child: Stack(
            children: <Widget>[
              widget.child,
              if (visible)
                // A bare Positioned sized to the pill: the Stack's empty area
                // absorbs no touches, so taps outside the pill still fall
                // through to the page below.
                Positioned(
                  left: AppSpacing.gutter,
                  bottom: safeBottom + float,
                  child: _FeedbackButton(
                    // The route the worker is ON when they tap — the whole
                    // answer to "which button kaam nahi kar raha". Travels as
                    // `extra` (in-memory, never in the URL) and is normalized
                    // into a route PATTERN at the wire boundary, so no
                    // identifier leaves the device.
                    onTap: () =>
                        widget.router.push(Routes.feedback, extra: _path),
                  ),
                ),
            ],
          ),
        );
      },
    );
  }
}

/// The button itself — a flat navy pill (v3: shift blue is structure, no
/// shadows). A custom pill rather than a [FloatingActionButton] so it needs no
/// Scaffold and carries no Hero tag that could clash with a page's own FAB.
class _FeedbackButton extends StatelessWidget {
  const _FeedbackButton({required this.onTap});

  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final BorderRadius radius = BorderRadius.circular(
      OnboardingRadii.feedbackButton,
    );
    // CHROME, so it clamps its own text scaling like every header and bar.
    // Unclamped, a 2.0 system font grew the pill from about 120x40 to 176x70 —
    // a fifth of a 320x568 screen, floating over the page's last control.
    return MediaQuery.withClampedTextScaling(
      maxScaleFactor: OnboardingLayout.chromeMaxTextScale,
      child: Material(
        color: OnboardingColors.shiftBlue,
        borderRadius: radius,
        child: InkWell(
          onTap: onTap,
          borderRadius: radius,
          child: ConstrainedBox(
            constraints: const BoxConstraints(
              minHeight: OnboardingLayout.tapTarget,
            ),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  const Icon(
                    Icons.chat_bubble_outline_rounded,
                    size: 16,
                    color: OnboardingColors.textOnBlue,
                  ),
                  const SizedBox(width: 8),
                  Text(
                    'Feedback',
                    style: OnboardingTypography.inter(
                      size: 13,
                      weight: FontWeight.w700,
                      color: OnboardingColors.textOnBlue,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
