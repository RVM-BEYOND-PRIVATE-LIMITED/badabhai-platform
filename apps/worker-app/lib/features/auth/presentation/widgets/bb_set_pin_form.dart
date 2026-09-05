import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../../../core/theme/app_colors.dart';
import '../../../../core/theme/app_spacing.dart';
import '../../../../core/theme/app_typography.dart';
import '../../../../core/widgets/bb_alert_dialog.dart';
import '../../../../core/widgets/bb_spinner.dart';
import '../../domain/weak_pin.dart';
import '../enter_pin_screen.dart' show kPinLength;
import 'bb_pin_view.dart';

/// Keys for the two OS-keyboard capture fields — stable finders for tests,
/// since both rows are on screen at once (no step to disambiguate by).
const Key kSetPinFirstFieldKey = Key('bb_set_pin_first_field');
const Key kSetPinConfirmFieldKey = Key('bb_set_pin_confirm_field');

/// ONE page, two rows: "enter" then "confirm" — both visible together, no
/// next-screen transition between them. The OS numeric keyboard drives entry
/// (NOT the custom [BbPinKeypad]); each row is an invisible [TextField] with a
/// [BbPinView] painted on top of it as the only thing the worker actually sees.
///
/// SECURITY: the digits never render — the invisible field carries them, the
/// box row only shows a COUNT (as a star per filled box). Both buffers are
/// LOCAL widget state, dropped the moment they are handed to [onConfirmed].
///
/// Owns the weak-PIN and mismatch dialogs end-to-end. [onConfirmed] fires
/// exactly once, with the confirmed PIN, after both rows are 4 digits, the
/// first passes [isWeakPin], and the two match.
class BbSetPinForm extends StatefulWidget {
  const BbSetPinForm({
    super.key,
    required this.enterLabel,
    required this.confirmLabel,
    required this.onConfirmed,
    this.busy = false,
    this.busyCaption = 'PIN set kar rahe hain…',
  });

  /// Eyebrow label above the first row (e.g. 'PIN DAALEIN').
  final String enterLabel;

  /// Eyebrow label above the second row (e.g. 'PIN DOBARA DAALEIN').
  final String confirmLabel;

  /// Fired once with the confirmed PIN. The caller owns the network call and
  /// its own failure handling — call [BbSetPinFormState.reset] (via a
  /// [GlobalKey]) afterwards to clear both rows on a server rejection.
  final ValueChanged<String> onConfirmed;

  /// True while the caller's submit is in flight — disables both fields, drops
  /// the keyboard, and shows [busyCaption] under the rows.
  final bool busy;

  final String busyCaption;

  @override
  State<BbSetPinForm> createState() => BbSetPinFormState();
}

class BbSetPinFormState extends State<BbSetPinForm> {
  final TextEditingController _firstCtrl = TextEditingController();
  final TextEditingController _confirmCtrl = TextEditingController();
  final FocusNode _firstFocus = FocusNode();
  final FocusNode _confirmFocus = FocusNode();

  /// True while an alert dialog is open, so a rapid tap or a rebuild can't
  /// stack a second dialog on top of the first.
  bool _dialogOpen = false;

  @override
  void initState() {
    super.initState();
    _firstCtrl.addListener(_onFirstChanged);
    _confirmCtrl.addListener(_onConfirmChanged);
    WidgetsBinding.instance
        .addPostFrameCallback((_) => _firstFocus.requestFocus());
  }

  @override
  void didUpdateWidget(BbSetPinForm oldWidget) {
    super.didUpdateWidget(oldWidget);
    // Submit started — drop the OS keyboard; there is nothing left to type.
    if (widget.busy && !oldWidget.busy) {
      _firstFocus.unfocus();
      _confirmFocus.unfocus();
    }
  }

  @override
  void dispose() {
    _firstCtrl.dispose();
    _confirmCtrl.dispose();
    _firstFocus.dispose();
    _confirmFocus.dispose();
    super.dispose();
  }

  void _onFirstChanged() {
    setState(() {}); // repaint the row's boxes as digits land
    if (_firstCtrl.text.length < kPinLength) return;
    if (isWeakPin(_firstCtrl.text)) {
      _blockWeakPin();
      return;
    }
    // Strong first entry — hand off straight to the confirm row.
    _confirmFocus.requestFocus();
  }

  void _onConfirmChanged() {
    setState(() {});
    if (_confirmCtrl.text.length < kPinLength) return;
    if (_confirmCtrl.text != _firstCtrl.text) {
      _mismatch();
      return;
    }
    final String pin = _firstCtrl.text;
    _firstFocus.unfocus();
    _confirmFocus.unfocus();
    widget.onConfirmed(pin);
  }

  /// Guessable PIN — block it, explain in a dialog, and clear just the first
  /// row (the confirm row is still empty at this point).
  Future<void> _blockWeakPin() async {
    if (_dialogOpen) return;
    _dialogOpen = true;
    _firstCtrl.clear();
    await showBbAlert(
      context,
      title: 'Yeh PIN aasan hai',
      message: '1234 ya 1111 jaisa PIN koi bhi aasani se guess kar sakta hai. '
          'Aisa 4-digit PIN chunein jo sirf aap jaante hain.',
    );
    if (mounted) {
      _dialogOpen = false;
      _firstFocus.requestFocus();
    }
  }

  /// The two entries differed — explain, and send the worker back to the start.
  Future<void> _mismatch() async {
    if (_dialogOpen) return;
    _dialogOpen = true;
    _firstCtrl.clear();
    _confirmCtrl.clear();
    await showBbAlert(
      context,
      title: 'PIN alag hai',
      message: 'Dono baar ek jaisa PIN daalein. '
          'Pehli baar aur confirm wala PIN abhi alag hain.',
    );
    if (mounted) {
      _dialogOpen = false;
      _firstFocus.requestFocus();
    }
  }

  /// Clears both rows and refocuses the first — the caller invokes this (via a
  /// [GlobalKey]) after a server rejection, so the worker starts clean rather
  /// than resubmitting the same rejected digits.
  void reset() {
    _firstCtrl.clear();
    _confirmCtrl.clear();
    if (mounted) {
      setState(() {});
      _firstFocus.requestFocus();
    }
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        _row(
          label: widget.enterLabel,
          fieldKey: kSetPinFirstFieldKey,
          controller: _firstCtrl,
          focus: _firstFocus,
        ),
        const SizedBox(height: AppSpacing.s7),
        _row(
          label: widget.confirmLabel,
          fieldKey: kSetPinConfirmFieldKey,
          controller: _confirmCtrl,
          focus: _confirmFocus,
        ),
        if (widget.busy) ...<Widget>[
          const SizedBox(height: AppSpacing.s6),
          Padding(
            padding: const EdgeInsets.symmetric(vertical: AppSpacing.s4),
            child: BbSpinner(caption: widget.busyCaption),
          ),
        ],
      ],
    );
  }

  Widget _row({
    required String label,
    required Key fieldKey,
    required TextEditingController controller,
    required FocusNode focus,
  }) {
    return Column(
      children: <Widget>[
        Text(label, style: AppTypography.eyebrow(color: AppColors.textMuted)),
        const SizedBox(height: AppSpacing.s3),
        GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: widget.busy ? null : () => focus.requestFocus(),
          child: Stack(
            alignment: Alignment.center,
            children: <Widget>[
              BbPinView(length: kPinLength, filled: controller.text.length),
              // The real capture surface — fully invisible; the boxes above are
              // the ONLY thing the worker sees. Still focusable/editable at any
              // size, so the OS numeric keyboard opens on tap.
              Opacity(
                opacity: 0,
                child: SizedBox(
                  width: 1,
                  height: 1,
                  child: TextField(
                    key: fieldKey,
                    controller: controller,
                    focusNode: focus,
                    enabled: !widget.busy,
                    keyboardType: TextInputType.number,
                    obscureText: true,
                    enableSuggestions: false,
                    autocorrect: false,
                    autofillHints: const <String>[],
                    showCursor: false,
                    inputFormatters: <TextInputFormatter>[
                      FilteringTextInputFormatter.digitsOnly,
                      LengthLimitingTextInputFormatter(kPinLength),
                    ],
                  ),
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}
