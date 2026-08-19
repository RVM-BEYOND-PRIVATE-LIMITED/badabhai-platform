import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../router.dart';
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
bool showFeedbackOn(String path) {
  if (path == _kSplash) return false;
  for (final String p in _kHiddenPrefixes) {
    if (path == p || path.startsWith('$p/')) return false;
  }
  return true;
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
  late String _path = _currentPath();
  bool _scheduled = false;

  @override
  void initState() {
    super.initState();
    widget.router.routerDelegate.addListener(_onNavigation);
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
      if (p != _path) setState(() => _path = p);
    });
  }

  @override
  Widget build(BuildContext context) {
    final bool keyboardOpen = MediaQuery.of(context).viewInsets.bottom > 0;
    return Stack(
      children: <Widget>[
        widget.child,
        if (showFeedbackOn(_path) && !keyboardOpen)
          Positioned(
            left: AppSpacing.gutter,
            bottom: MediaQuery.of(context).padding.bottom + _kBottomInset,
            child: _FeedbackButton(
              onTap: () => widget.router.push(Routes.feedback),
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
