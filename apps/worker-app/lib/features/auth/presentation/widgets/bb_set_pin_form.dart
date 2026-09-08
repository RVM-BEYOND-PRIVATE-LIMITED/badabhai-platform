import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../../../core/theme/app_colors.dart';
import '../../../../core/theme/app_spacing.dart';
import '../../../../core/theme/app_typography.dart';
import '../../../../core/widgets/bb_alert_dialog.dart';
import '../../../../core/widgets/bb_spinner.dart';
import '../enter_pin_screen.dart' show kPinLength;
import 'bb_pin_view.dart';

/// Keys for the two OS-keyboard capture fields — stable finders for tests,
/// since both rows are on screen at once (no step to disambiguate by).
const Key kSetPinFirstFieldKey = Key('bb_set_pin_first_field');
const Key kSetPinConfirmFieldKey = Key('bb_set_pin_confirm_field');

/// ONE page, two rows: "enter" then "confirm" — both visible together, no
/// next-screen transition between them. The OS numeric keyboard drives entry
/// (NOT the custom [BbPinKeypad]); each row is a TRANSPARENT [TextField]
/// spanning the whole row, with a [BbPinView] painted under it as the only
/// thing the worker actually sees.
///
/// THE ROW SHOWS WHERE THE WORKER IS (#1463). [BbPinView] is told which row
/// holds focus, and paints a ring plus a blinking caret on the slot the next
/// digit lands in. Before that the capture field was a 1x1 box under
/// `Opacity(0)` with `showCursor: false`, so there was no caret anywhere on
/// the screen and no way to tell which of the two rows was live — the
/// auto-advance to the confirm row happened invisibly.
///
/// SECURITY: the digits never render — the field carries them masked twice
/// over (`obscureText` plus a fully transparent glyph colour) and refuses
/// selection, so nothing can lift a PIN to the clipboard; the box row only
/// shows a COUNT (as a star per filled box). Both buffers are LOCAL widget
/// state, dropped the moment they are handed to [onConfirmed].
///
/// Owns the mismatch dialog end-to-end. [onConfirmed] fires exactly once, with
/// the confirmed PIN, as soon as both rows are 4 digits and the two match.
/// There is NO strength gate here (#1464): any 4 digits the worker picks are
/// accepted by this form.
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
    // #1463 — the ring and the caret live in the PAINT, so a focus change has
    // to repaint. Without these two the rows could not show which one is live,
    // and the auto-advance to the confirm row would happen invisibly.
    _firstFocus.addListener(_onFocusChanged);
    _confirmFocus.addListener(_onFocusChanged);
    WidgetsBinding.instance
        .addPostFrameCallback((_) => _focusRow(_firstCtrl, _firstFocus));
  }

  void _onFocusChanged() {
    if (mounted) setState(() {});
  }

  /// Focus a row AND park the caret at the end of whatever it already holds.
  ///
  /// Flutter would land there by itself on a cleared row (an invalid selection
  /// resolves to `text.length` on focus), but not deterministically on a row
  /// the worker is coming BACK to. Setting it explicitly means the next digit
  /// always appends and backspace always bites the last digit — the whole of
  /// what "editable" means for a 4-digit masked field.
  void _focusRow(TextEditingController controller, FocusNode focus) {
    controller.selection =
        TextSelection.collapsed(offset: controller.text.length);
    focus.requestFocus();
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
    _firstFocus.removeListener(_onFocusChanged);
    _confirmFocus.removeListener(_onFocusChanged);
    _firstFocus.dispose();
    _confirmFocus.dispose();
    super.dispose();
  }

  void _onFirstChanged() {
    setState(() {}); // repaint the row's boxes as digits land
    if (_firstCtrl.text.length < kPinLength) return;
    // NO client-side strength gate (#1464 — owner ruling): the worker may pick
    // ANY 4 digits, 1234 and 1111 included. The screen used to hard-block a
    // guessable PIN here with a dialog; that is gone. The server still runs its
    // own denylist for now, so such a PIN comes back as a plain submit failure
    // (see the caller's failure dialog) until that policy is lifted too —
    // tracked for the backend owner.
    // Full first entry — hand off straight to the confirm row. The ring and
    // caret move with it, which is the ONLY thing telling the worker the
    // second row is now the live one.
    _focusRow(_confirmCtrl, _confirmFocus);
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
      _focusRow(_firstCtrl, _firstFocus);
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
      _focusRow(_firstCtrl, _firstFocus);
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
          onTap: widget.busy ? null : () => _focusRow(controller, focus),
          child: Stack(
            alignment: Alignment.center,
            children: <Widget>[
              BbPinView(
                length: kPinLength,
                filled: controller.text.length,
                // #1463 — this is what puts the ring and the caret on the row
                // the worker is actually typing into.
                focused: focus.hasFocus,
              ),
              // The real capture surface. TRANSPARENT, NOT COLLAPSED (#1463):
              // it used to be a 1x1 box under Opacity(0), which the OS could
              // barely treat as a field — the same trap the OTP screen calls
              // out ("a collapsed field cannot be tapped or long-pressed").
              // Filling the row instead gives the keyboard a real target the
              // worker can hit anywhere along the boxes.
              //
              // The digits are masked TWICE over: obscureText replaces them
              // with bullets, and the text colour is fully transparent on top
              // of that. The boxes below remain the only thing on screen, and
              // they only ever receive a COUNT.
              Positioned.fill(
                child: TextField(
                  key: fieldKey,
                  controller: controller,
                  focusNode: focus,
                  enabled: !widget.busy,
                  keyboardType: TextInputType.number,
                  textAlign: TextAlign.center,
                  obscureText: true,
                  enableSuggestions: false,
                  autocorrect: false,
                  autofillHints: const <String>[],
                  // A PIN is not copy/paste material: no selection handles, no
                  // toolbar, nothing that could lift it to the clipboard.
                  enableInteractiveSelection: false,
                  // Flutter's own caret would sit at the CENTRE of the row,
                  // nowhere near the box being filled. BbPinView paints the
                  // caret in the active slot instead.
                  showCursor: false,
                  cursorColor: Colors.transparent,
                  style: const TextStyle(color: Colors.transparent),
                  inputFormatters: <TextInputFormatter>[
                    FilteringTextInputFormatter.digitsOnly,
                    LengthLimitingTextInputFormatter(kPinLength),
                  ],
                  decoration: const InputDecoration(
                    counterText: '',
                    filled: false,
                    isCollapsed: true,
                    border: InputBorder.none,
                    enabledBorder: InputBorder.none,
                    focusedBorder: InputBorder.none,
                    disabledBorder: InputBorder.none,
                    contentPadding: EdgeInsets.zero,
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
