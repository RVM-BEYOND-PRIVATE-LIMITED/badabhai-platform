import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import '../../../core/di/locator.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_alert_dialog.dart';
import '../../../core/widgets/bb_blue_header.dart';
import '../../../core/widgets/bb_spinner.dart';
import '../../../router.dart';
import 'cubit/enter_pin_cubit.dart';
import 'widgets/bb_pin_keypad.dart';
import 'widgets/bb_pin_view.dart';

/// PIN length the app uses everywhere (set + unlock). Single source so the dot
/// count and the auto-submit threshold never drift.
const int kPinLength = 4;

/// Enter-PIN (unlock) — the fast path on cold start and after a re-lock.
///
/// The masked keypad assembles the PIN in LOCAL state only; it is forwarded to
/// the cubit on the last digit and cleared from memory immediately. On a wrong
/// PIN the dots flash crimson and the NEUTRAL "PIN sahi nahi…" copy is shown in a
/// CENTRED, blocking dialog (a "Theek hai" acknowledge) — the same treatment as
/// the set-PIN errors, so a low-literacy worker cannot miss it. The backend gives
/// one opaque 401 per failure, so there is no attempts/countdown UI. After a few
/// soft fails the "PIN bhool gaye?" link is emphasized; it starts the forgot-PIN
/// flow.
class EnterPinScreen extends StatelessWidget {
  const EnterPinScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return BlocProvider<EnterPinCubit>(
      create: (_) => locator<EnterPinCubit>(),
      child: const _EnterPinView(),
    );
  }
}

class _EnterPinView extends StatefulWidget {
  const _EnterPinView();

  @override
  State<_EnterPinView> createState() => _EnterPinViewState();
}

class _EnterPinViewState extends State<_EnterPinView> {
  /// The PIN buffer — LOCAL widget state only. Never persisted, never logged;
  /// cleared after each submit.
  String _pin = '';

  /// True while the wrong-PIN dialog is open, so repeated failures can't stack
  /// a second dialog on top of the first.
  bool _dialogOpen = false;

  /// True during the brief pop-beat after the 4th digit, before the PIN is
  /// submitted — input is frozen so a stray tap can't corrupt the PIN mid-beat.
  bool _submitting = false;

  Future<void> _onDigit(String d) async {
    if (_submitting) return;
    if (_pin.length >= kPinLength) return;
    setState(() => _pin += d);
    if (_pin.length < kPinLength) return;

    // Let the 4th dot finish its fill-pop, THEN submit — but KEEP the dots
    // FILLED through the verify. Blanking them the instant the 4th digit lands
    // (as this used to) read like a reset / wrong PIN, and a worker re-entered a
    // correct PIN. Instead the keypad is swapped for a loader (build) while the
    // unlock is in flight, and the dots are cleared ONLY on a wrong PIN, after
    // the worker has acknowledged it (see [_showError]).
    _submitting = true;
    await Future<void>.delayed(BbPinView.fillPopSettle);
    if (!mounted) return;
    _submitting = false;
    context.read<EnterPinCubit>().unlock(_pin);
  }

  void _onBackspace() {
    if (_submitting) return;
    if (_pin.isEmpty) return;
    setState(() => _pin = _pin.substring(0, _pin.length - 1));
  }

  /// Surface a wrong-PIN (or unknown-error) failure in a centred dialog with a
  /// single "Theek hai" button — matching the set-PIN errors. Guarded by
  /// [_dialogOpen] so a fast retry can't stack dialogs.
  Future<void> _showError(String? message) async {
    if (_dialogOpen) return;
    _dialogOpen = true;
    final String text = (message == null || message.isEmpty)
        ? 'PIN sahi nahi — dobara try karein, ya \'PIN bhool gaye?\''
        : message;
    await showBbAlert(context, title: 'PIN sahi nahi', message: text);
    if (mounted) {
      _dialogOpen = false;
      // Clear ONLY now — after the worker has seen the wrong-PIN dialog — so a
      // fresh retry starts from empty dots. (On success the dots stay filled
      // until the router navigates away; they never blank mid-verify.)
      setState(() => _pin = '');
    }
  }

  @override
  Widget build(BuildContext context) {
    // On unlock the ROUTER REDIRECT owns where we land — it fires on the status
    // change via `refreshListenable`, restores the location the re-lock
    // interrupted (#349), falls back to the Resume tab, and applies the TD62
    // consent gate. The listener here ONLY surfaces the failure dialog; it never
    // navigates (two owners of post-unlock routing was the #349 bug).
    return BlocConsumer<EnterPinCubit, EnterPinState>(
      listenWhen: (EnterPinState p, EnterPinState c) => p.status != c.status,
      listener: (BuildContext context, EnterPinState state) {
        if (state.status == EnterPinStatus.failure) _showError(state.message);
      },
      builder: (BuildContext context, EnterPinState state) {
        final bool error = state.status == EnterPinStatus.failure;
        // Kit auth chrome: blue header carries the title/context; the light body
        // holds the masked dots + on-screen keypad. Not [BbScaffold] — the header
        // bleeds to the status bar. No back button: this is the locked root.
        return Scaffold(
          body: Column(
            children: <Widget>[
              const BbBlueHeader(
                title: 'PIN daalein',
                subtitle: 'Apne account mein wapas aane ke liye PIN daalein.',
              ),
              Expanded(
                child: SafeArea(
                  top: false,
                  child: Padding(
                    padding: const EdgeInsets.symmetric(
                        horizontal: AppSpacing.gutter),
                    child: Column(
                      children: <Widget>[
                        const Spacer(flex: 2),
                        BbPinView(
                          length: kPinLength,
                          filled: _pin.length,
                          error: error,
                        ),
                        // The wrong-PIN reason now lives in the centred dialog
                        // (see [_showError]) — no tiny inline line here.
                        const SizedBox(height: AppSpacing.s8),
                        // While the PIN is being verified, swap the keypad for a
                        // loader so the worker sees WORK IN PROGRESS — the dots
                        // stay filled above and never blank mid-verify.
                        if (state.isSubmitting)
                          const Padding(
                            padding:
                                EdgeInsets.symmetric(vertical: AppSpacing.s4),
                            child:
                                BbSpinner(caption: 'PIN check kar rahe hain…'),
                          )
                        else
                          BbPinKeypad(
                            onDigit: _onDigit,
                            onBackspace: _onBackspace,
                          ),
                        const Spacer(flex: 1),
                        TextButton(
                          onPressed: () => context.push(Routes.forgotPin),
                          child: Text(
                            // After enough soft fails, nudge toward the reset flow.
                            state.suggestForgot
                                ? 'PIN bhool gaye? Naya PIN banayein'
                                : 'PIN bhool gaye?',
                            style: AppTypography.body(
                              // Deep-blue link in BOTH states — haldi (brand) as
                              // body text on white is ~1.4:1 and illegible; the
                              // w700 weight carries the emphasis when suggestForgot.
                              weight: FontWeight.w700,
                              color: AppColors.textLink,
                            ),
                          ),
                        ),
                        const SizedBox(height: AppSpacing.s4),
                      ],
                    ),
                  ),
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}
