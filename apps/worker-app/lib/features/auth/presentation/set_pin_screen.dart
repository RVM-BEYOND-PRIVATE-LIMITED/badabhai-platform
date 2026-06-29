import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import '../../../core/di/locator.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_app_bar.dart';
import '../../../core/widgets/bb_scaffold.dart';
import '../../../router.dart';
import '../domain/weak_pin.dart';
import 'cubit/set_pin_cubit.dart';
import 'enter_pin_screen.dart' show kPinLength;
import 'widgets/bb_pin_keypad.dart';
import 'widgets/bb_pin_view.dart';

/// Set / reset PIN. Two steps: enter a PIN, then re-enter to confirm it matches.
/// A gentle weak-PIN HINT shows for an obvious PIN (1111 / 1234) but never
/// blocks — the server is the real policy. On success the manager authenticates;
/// a new user continues onboarding (consent), a reset returns to the shell.
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
  String? _error;

  String get _buffer => _step == _Step.enter ? _first : _confirm;

  void _onDigit(String d) {
    if (_buffer.length >= kPinLength) return;
    setState(() {
      _error = null;
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
      _error = null;
      if (_step == _Step.enter && _first.isNotEmpty) {
        _first = _first.substring(0, _first.length - 1);
      } else if (_step == _Step.confirm && _confirm.isNotEmpty) {
        _confirm = _confirm.substring(0, _confirm.length - 1);
      }
    });
  }

  void _advance() {
    if (_step == _Step.enter) {
      // Move to confirm. Keep the gentle hint visible there if it is weak.
      setState(() {
        _error = isWeakPin(_first)
            ? '1111 / 1234 jaise PIN na chunein — thoda mushkil rakhein.'
            : null;
        _step = _Step.confirm;
      });
      return;
    }
    // Confirm step filled — must match.
    if (_confirm != _first) {
      setState(() {
        _error = 'PIN match nahi hua. Dobara try karein.';
        _confirm = '';
        _first = '';
        _step = _Step.enter;
      });
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

  @override
  Widget build(BuildContext context) {
    final bool confirming = _step == _Step.confirm;
    return BlocConsumer<SetPinCubit, SetPinState>(
      listenWhen: (SetPinState p, SetPinState c) => p.status != c.status,
      listener: (BuildContext context, SetPinState state) {
        if (state.status == SetPinStatus.done) {
          // New user → continue onboarding at consent; reset → back to the shell.
          context.go(widget.isReset ? Routes.resume : Routes.consent);
        } else if (state.status == SetPinStatus.failure) {
          setState(() {
            _error = state.message;
            _step = _Step.enter;
            _first = '';
            _confirm = '';
          });
        }
      },
      builder: (BuildContext context, SetPinState state) {
        final bool weak = _error != null;
        return BbScaffold(
          appBar: BbAppBar(title: widget.isReset ? 'Naya PIN' : 'PIN banayein'),
          body: Column(
            children: <Widget>[
              const Spacer(flex: 1),
              Icon(
                confirming ? Icons.check_circle_outline : Icons.pin_outlined,
                size: 40,
                color: AppColors.brand,
              ),
              const SizedBox(height: AppSpacing.s4),
              Text(
                confirming ? 'PIN dobara daalein' : '4-digit PIN banayein',
                style: AppTypography.display(size: AppTypography.sizeXl),
              ),
              const SizedBox(height: AppSpacing.s2),
              Text(
                confirming
                    ? 'Confirm karne ke liye wahi PIN dobara daalein.'
                    : 'Har baar isi PIN se aap login karenge.',
                textAlign: TextAlign.center,
                style: AppTypography.body(color: AppColors.textSecondary),
              ),
              const SizedBox(height: AppSpacing.s7),
              BbPinView(
                length: kPinLength,
                filled: _buffer.length,
                error: weak && !confirming ? false : weak,
              ),
              const SizedBox(height: AppSpacing.s4),
              SizedBox(
                height: AppSpacing.s8,
                child: _error != null
                    ? Padding(
                        padding: const EdgeInsets.symmetric(
                            horizontal: AppSpacing.s4),
                        child: Text(
                          _error!,
                          textAlign: TextAlign.center,
                          style: AppTypography.body(
                            size: AppTypography.sizeSm,
                            color: AppColors.warning,
                          ),
                        ),
                      )
                    : null,
              ),
              const SizedBox(height: AppSpacing.s2),
              BbPinKeypad(
                enabled: !state.isSubmitting,
                onDigit: _onDigit,
                onBackspace: _onBackspace,
              ),
              const Spacer(flex: 2),
            ],
          ),
        );
      },
    );
  }
}
