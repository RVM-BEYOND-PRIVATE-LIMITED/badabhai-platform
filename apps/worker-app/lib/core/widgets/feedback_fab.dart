import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../features/auth/domain/auth_session_manager.dart';
import '../../router.dart';
import '../di/locator.dart';
import '../theme/app_colors.dart';
import '../theme/app_spacing.dart';
import '../theme/app_typography.dart';

/// Route path where the floating Feedback button is HIDDEN, matched EXACTLY so a
/// prefix rule can't swallow the whole app: splash.
const String _kSplash = '/';

/// Route path PREFIXES where the button is hidden. Kept to the MINIMUM:
///  - the FEEDBACK page itself — else tapping it stacks /feedback on /feedback
///    forever (the reported infinite-stack bug), and
///  - the PRE-LOGIN screens (login / OTP / PIN) — feedback is worker-authed, so
///    with no session token there yet a tap would only 401; a dead button is
///    worse than no button.
/// Everywhere the worker is logged in (including consent + name onboarding) shows
/// it.
const List<String> _kHiddenPrefixes = <String>[
  Routes.phoneLogin, // /login
  Routes.otpVerify, // /otp
  Routes.pin, // /pin (covers /pin/set, /pin/forgot) — locked, no session token
  Routes.feedback, // don't offer feedback from the feedback page (anti-stack)
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
  if (path == _kSplash) return false;
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
/// [BbBottomNav] on the tab pages so it never covers a nav item. On full-screen
/// pages it simply floats a little higher, consistently.
const double _kBottomInset = 72;

/// Overlays a FIXED bottom-LEFT "Feedback" button on every non-auth page (CEO
/// request). Lives ONCE in the MaterialApp builder — above the router's Navigator
/// and the bottom nav — so a single instance covers the whole app instead of
/// each screen re-adding one. Steps out of the way while the keyboard is open so
/// it never sits over a composer.
///
/// ROUTE SOURCE: it tracks `router.routerDelegate.currentConfiguration` — the
/// RESOLVED current location, which updates on every navigation INCLUDING a
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

  String _currentPath() {
    final String p = widget.router.routerDelegate.currentConfiguration.uri.path;
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
    return Stack(
      children: <Widget>[
        widget.child,
        if (showFeedbackOn(_path, consentAccepted: _consentAccepted) &&
            !keyboardOpen)
          Positioned(
            left: AppSpacing.gutter,
            bottom: MediaQuery.of(context).padding.bottom + _kBottomInset,
            child: _FeedbackButton(
              // The route the worker is ON when they tap — the whole answer to
              // "which button kaam nahi kar raha". Travels as `extra` (in-memory,
              // never in the URL) and is normalized into a route PATTERN at the
              // wire boundary, so no identifier leaves the device.
              onTap: () => widget.router.push(Routes.feedback, extra: _path),
            ),
          ),
      ],
    );
  }
}

/// The button itself — a flat deep-blue pill (JUL31 "Josh": blue = structure, no
/// shadows). A custom pill rather than a [FloatingActionButton] so it needs no
/// Scaffold and carries no Hero tag that could clash with a page's own FAB.
class _FeedbackButton extends StatelessWidget {
  const _FeedbackButton({required this.onTap});

  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: AppColors.blue,
      borderRadius: BorderRadius.circular(AppRadii.lg),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(AppRadii.lg),
        child: Padding(
          padding: const EdgeInsets.symmetric(
            horizontal: AppSpacing.s4,
            vertical: AppSpacing.s3,
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              const Icon(Icons.feedback_outlined,
                  size: 20, color: AppColors.onBlue),
              const SizedBox(width: AppSpacing.s2),
              Text(
                'Feedback',
                style: AppTypography.body(
                  size: AppTypography.sizeSm,
                  weight: FontWeight.w700,
                  color: AppColors.onBlue,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
