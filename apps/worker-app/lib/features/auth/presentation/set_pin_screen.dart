import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import '../../../core/di/locator.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/widgets/bb_alert_dialog.dart';
import '../../../core/widgets/bb_blue_header.dart';
import '../../../core/widgets/bb_scroll_safe_body.dart';
import '../../../router.dart';
import 'cubit/set_pin_cubit.dart';
import 'widgets/bb_set_pin_form.dart';

/// Set / reset PIN — ONE page: the enter row and the confirm row are both on
/// screen together (no next-screen transition between them), driven by the OS
/// numeric keyboard via [BbSetPinForm] — not a custom on-screen keypad.
///
/// Every error the worker can hit is a CENTRED, blocking [showBbAlert]:
///  - a guessable PIN (1111 / 1234) is a HARD CLIENT BLOCK, explained in a
///    dialog ([BbSetPinForm] owns this).
///  - a confirm mismatch clears both rows and explains in a dialog
///    ([BbSetPinForm] owns this too).
///  - a server rejection surfaces its full reason here and resets both rows.
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

class _SetPinView extends StatefulWidget {
  const _SetPinView({required this.isReset});

  final bool isReset;

  @override
  State<_SetPinView> createState() => _SetPinViewState();
}

class _SetPinViewState extends State<_SetPinView> {
  final GlobalKey<BbSetPinFormState> _formKey = GlobalKey<BbSetPinFormState>();

  /// True while an alert dialog is open, so a rapid tap or a rebuild can't stack
  /// a second dialog on top of the first.
  bool _dialogOpen = false;

  /// The server rejected the PIN — surface its full reason, then reset both rows.
  Future<void> _showFailureAlert(String? message) async {
    if (_dialogOpen) return;
    _dialogOpen = true;
    final String text = (message == null || message.isEmpty)
        ? 'Kuch gadbad ho gayi. Dobara try karein.'
        : message;
    await showBbAlert(context, title: 'PIN set nahi hua', message: text);
    if (mounted) {
      _dialogOpen = false;
      _formKey.currentState?.reset();
    }
  }

  @override
  Widget build(BuildContext context) {
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
        // Kit auth chrome: the blue header carries the screen title/subtitle;
        // the light body holds both PIN rows at once. Reached via `go` (new-user
        // onboarding or reset), so no back affordance.
        return Scaffold(
          body: Column(
            children: <Widget>[
              BbBlueHeader(
                title: widget.isReset ? 'Naya PIN' : 'PIN banayein',
                subtitle: 'Pehle naya PIN daalein, fir confirm karne ke liye '
                    'wahi PIN dobara daalein.',
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
                        BbSetPinForm(
                          key: _formKey,
                          enterLabel: 'PIN DAALEIN',
                          confirmLabel: 'PIN DOBARA DAALEIN',
                          busy: state.isSubmitting,
                          busyCaption: 'PIN set kar rahe hain…',
                          onConfirmed: (String pin) =>
                              context.read<SetPinCubit>().submit(pin),
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
