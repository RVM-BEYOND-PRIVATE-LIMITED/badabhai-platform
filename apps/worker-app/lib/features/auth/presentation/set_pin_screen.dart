import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import '../../../core/di/locator.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/widgets/bb_alert_dialog.dart';
import '../../../core/widgets/bb_blue_header.dart';
import '../../../core/widgets/bb_scroll_safe_body.dart';
import '../../../core/widgets/bb_spinner.dart';
import '../../../router.dart';
import '../domain/weak_pin.dart';
import 'cubit/set_pin_cubit.dart';
import 'enter_pin_screen.dart' show kPinLength;
import 'widgets/bb_pin_keypad.dart';
import 'widgets/bb_pin_view.dart';

/// Set / reset PIN. Two steps: enter a PIN, then re-enter to confirm it matches.
///
/// Every error the worker can hit is a CENTRED, blocking [showBbAlert] — not the
/// old tiny inline red text a first-time, low-literacy worker scrolled past:
///  - a guessable PIN (1111 / 1234) is a HARD CLIENT BLOCK ([isWeakPin]): the
///    dialog explains why and the worker stays on the enter step. The server is
///    still the ultimate policy authority, but we no longer let an obviously
///    weak PIN sail through to a late server rejection the worker won't
///    understand.
///  - a confirm mismatch and a server rejection each raise their own dialog and
///    return the worker to the enter step.
///
/// On success the manager authenticates; a new user continues onboarding
/// (consent), a reset returns to the shell.
class SetPinScreen extends StatelessWidget {
  const SetPinScreen({super.key, this.isReset = false});

  /// True when reached from forgot-PIN (returns to the shell on success) rather
  /// than the new-user onboarding (continues to consent).
  final bool isReset;

  @override
  Widget build(BuildContext context) {
    return BlocProvider<SetPinCubit>(
      create: (_) => locator<SetPinCubit>(),
      child: _SetPinView(isReset: isReset),
    );
  }
}

enum _Step { enter, confirm }

class _SetPinView extends StatefulWidget {
  const _SetPinView({required this.isReset});

  final bool isReset;

  @override
  State<_SetPinView> createState() => _SetPinViewState();
}

class _SetPinViewState extends State<_SetPinView> {
  _Step _step = _Step.enter;

  /// Both buffers are LOCAL widget state only — never persisted, never logged.
  String _first = '';
  String _confirm = '';

  /// True while an alert dialog is open, so a rapid tap or a rebuild can't stack
  /// a second dialog on top of the first.
  bool _dialogOpen = false;

  String get _buffer => _step == _Step.enter ? _first : _confirm;

  void _onDigit(String d) {
    if (_buffer.length >= kPinLength) return;
    setState(() {
      if (_step == _Step.enter) {
        _first += d;
      } else {
        _confirm += d;
      }
    });
    if (_buffer.length == kPinLength) _advance();
  }

  void _onBackspace() {
    setState(() {
      if (_step == _Step.enter && _first.isNotEmpty) {
        _first = _first.substring(0, _first.length - 1);
      } else if (_step == _Step.confirm && _confirm.isNotEmpty) {
        _confirm = _confirm.substring(0, _confirm.length - 1);
      }
    });
  }

  void _advance() {
    if (_step == _Step.enter) {
      // HARD client block on an obviously guessable PIN — dialog, then stay.
      if (isWeakPin(_first)) {
        _blockWeakPin();
        return;
      }
      _startConfirmTransition();
      return;
    }
    // Confirm step filled — must match.
    if (_confirm != _first) {
      _mismatch();
      return;
    }
    final String pin = _first;
    // Drop both buffers before handing the PIN to the cubit.
    setState(() {
      _first = '';
      _confirm = '';
    });
    context.read<SetPinCubit>().submit(pin);
  }

  /// Moves straight to the confirm step, no loading beat in between — one
  /// continuous entry, not a page-feeling transition.
  Future<void> _startConfirmTransition() async {
    // Let the 4th dot finish its fill-pop BEFORE swapping the header/step
    // (a same-frame layout change otherwise eats the pop the first three
    // showed).
    await Future<void>.delayed(BbPinView.fillPopSettle);
    // A backspace during that beat drops the buffer below full — abort and let
    // the worker keep typing rather than advancing a partial PIN.
    if (!mounted || _first.length != kPinLength) return;
    setState(() => _step = _Step.confirm);
  }

  /// Guessable PIN — block it, explain in a dialog, and stay on the enter step.
  /// The buffer is cleared SYNCHRONOUSLY (before the await) so a re-tap while the
  /// dialog animates in can't re-fire this.
  Future<void> _blockWeakPin() async {
    if (_dialogOpen) return;
    _dialogOpen = true;
    setState(() {
      _first = '';
      _step = _Step.enter;
    });
    await showBbAlert(
      context,
      title: 'Yeh PIN aasan hai',
      message: '1234 ya 1111 jaisa PIN koi bhi aasani se guess kar sakta hai. '
          'Aisa 4-digit PIN chunein jo sirf aap jaante hain.',
    );
    if (mounted) _dialogOpen = false;
  }

  /// The two entries differed — explain, and send the worker back to the start.
  Future<void> _mismatch() async {
    if (_dialogOpen) return;
    _dialogOpen = true;
    setState(() {
      _first = '';
      _confirm = '';
      _step = _Step.enter;
    });
    await showBbAlert(
      context,
      title: 'PIN alag hai',
      message: 'Dono baar ek jaisa PIN daalein. '
          'Pehli baar aur confirm wala PIN abhi alag hain.',
    );
    if (mounted) _dialogOpen = false;
  }

  /// The server rejected the PIN — surface its full reason, then reset to enter.
  Future<void> _showFailureAlert(String? message) async {
    if (_dialogOpen) return;
    _dialogOpen = true;
    final String text = (message == null || message.isEmpty)
        ? 'Kuch gadbad ho gayi. Dobara try karein.'
        : message;
    setState(() {
      _first = '';
      _confirm = '';
      _step = _Step.enter;
    });
    await showBbAlert(context, title: 'PIN set nahi hua', message: text);
    if (mounted) _dialogOpen = false;
  }

  @override
  Widget build(BuildContext context) {
    final bool confirming = _step == _Step.confirm;
    return BlocConsumer<SetPinCubit, SetPinState>(
      listenWhen: (SetPinState p, SetPinState c) => p.status != c.status,
      listener: (BuildContext context, SetPinState state) {
        if (state.status == SetPinStatus.done) {
          // Reset → confirm it landed with a toast, then back to the shell. New
          // user → continue onboarding at consent (no toast; onboarding speaks
          // for itself). The messenger is the app-level one (above the router's
          // Navigator), so the SnackBar survives the `go` and shows on the shell.
          if (widget.isReset) {
            ScaffoldMessenger.of(context)
              ..clearSnackBars()
              ..showSnackBar(
                const SnackBar(content: Text('PIN reset kar diya gaya hai')),
              );
          }
          context.go(widget.isReset ? Routes.resume : Routes.consent);
        } else if (state.status == SetPinStatus.failure) {
          _showFailureAlert(state.message);
        }
      },
      builder: (BuildContext context, SetPinState state) {
        // Kit auth chrome: the blue header carries the step title/subtitle; the
        // light body holds the masked dots + on-screen keypad. Reached via `go`
        // (new-user onboarding or reset), so no back affordance.
        return Scaffold(
          body: Column(
            children: <Widget>[
              BbBlueHeader(
                // Enter-step title kept EXACT ('PIN banayein' / reset 'Naya PIN')
                // — it is the set-PIN screen's identity in auth_routing_test.
                title: confirming
                    ? 'PIN dobara daalein'
                    : (widget.isReset ? 'Naya PIN' : 'PIN banayein'),
                subtitle: confirming
                    ? 'Confirm karne ke liye wahi PIN dobara daalein.'
                    : 'Har baar isi PIN se aap login karenge.',
              ),
              Expanded(
                child: SafeArea(
                  top: false,
                  // Scroll-safe centring: the body sits centred when there is
                  // room and scrolls (never overflows) on a short screen.
                  child: BbScrollSafeBody(
                    padding: const EdgeInsets.symmetric(
                        horizontal: AppSpacing.gutter),
                    child: Column(
                      children: <Widget>[
                        const Spacer(flex: 1),
                        BbPinView(
                          length: kPinLength,
                          filled: _buffer.length,
                        ),
                        const SizedBox(height: AppSpacing.s6),
                        // The real submit-to-server call — the ONLY wait left
                        // now that the artificial between-steps beat is gone.
                        if (state.isSubmitting)
                          const Padding(
                            padding: EdgeInsets.symmetric(
                                vertical: AppSpacing.s6),
                            child: BbSpinner(
                              caption: 'PIN set kar rahe hain…',
                            ),
                          )
                        else
                          BbPinKeypad(
                            enabled: true,
                            onDigit: _onDigit,
                            onBackspace: _onBackspace,
                          ),
                        const Spacer(flex: 2),
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
