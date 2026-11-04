import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../theme/app_colors.dart';
import '../theme/app_motion.dart';
import '../theme/app_spacing.dart';
import '../theme/app_typography.dart';
import 'bb_field_error.dart';

/// The one-time-code entry (#2595, M7): [length] boxes (six) that read as one
/// field.
///
/// ONE real [TextField] lies transparent over the boxes and owns all the input,
/// so everything the platform does for a code field keeps working — the
/// keyboard's SMS-code suggestion ([AutofillHints.oneTimeCode]), long-press
/// paste and backspace — while the boxes only DRAW its digits:
///  - **Typing** fills the boxes left to right; the next box to fill is edged
///    in the focus blue.
///  - **Paste** of a full code fills every box at once — "Your OTP is 123456",
///    "123-456", even over a code already entered (a pasted code replaces it).
///  - **Backspace** removes the last digit and steps the active box back.
///  - [onCompleted] fires as the last digit lands (typed, pasted or
///    autofilled) — the caller's auto-submit. It fires again only for a
///    DIFFERENT complete code, or after a digit was removed and re-entered.
///
/// Each box pops as its digit lands: scale [AppMotion.popScale] (1.04) over
/// [AppMotion.press] (90ms) — transform only, none under reduced motion.
class BbOtpInput extends StatefulWidget {
  const BbOtpInput({
    super.key,
    this.length = 6,
    this.controller,
    this.focusNode,
    this.onChanged,
    this.onCompleted,
    this.errorText,
    this.autofocus = false,
    this.enabled = true,
    this.semanticLabel = 'One-time code',
    this.fieldKey,
  }) : assert(length > 0);

  /// Digits in the code.
  final int length;

  /// Holds the digits typed so far; owned by the caller when given.
  final TextEditingController? controller;
  final FocusNode? focusNode;

  /// Fires on every edit with the digits entered so far.
  final ValueChanged<String>? onChanged;

  /// Fires with the whole code when its last digit lands (auto-submit).
  final ValueChanged<String>? onCompleted;

  /// Inline error under the boxes (e.g. a wrong code), or null.
  final String? errorText;

  final bool autofocus;
  final bool enabled;

  /// What a screen reader calls the field.
  final String semanticLabel;

  /// Key of the underlying [TextField] (for widget tests).
  final Key? fieldKey;

  /// Key of box [index]'s pop transition (for widget tests).
  @visibleForTesting
  static Key boxKey(int index) => ValueKey<String>('bb_otp_box_$index');

  /// Gap between two boxes.
  static const double boxGap = AppSpacing.s2;

  /// Height of a box — above the 48px tap floor.
  static const double boxHeight = AppSpacing.s9 + AppSpacing.s2;

  /// Widest a box grows on a wide screen.
  static const double boxMaxWidth = AppSpacing.controlLg;

  @override
  State<BbOtpInput> createState() => _BbOtpInputState();
}

class _BbOtpInputState extends State<BbOtpInput> {
  TextEditingController? _ownController;
  FocusNode? _ownFocusNode;

  TextEditingController get _controller =>
      widget.controller ?? (_ownController ??= TextEditingController());
  FocusNode get _focusNode =>
      widget.focusNode ?? (_ownFocusNode ??= FocusNode(debugLabel: 'otp'));

  /// The last complete code handed to [BbOtpInput.onCompleted]; cleared when
  /// the code becomes incomplete again.
  String? _completed;

  @override
  void initState() {
    super.initState();
    _controller.addListener(_onControllerChanged);
    _focusNode.addListener(_onFocusChanged);
  }

  @override
  void didUpdateWidget(BbOtpInput oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.controller != widget.controller) {
      (oldWidget.controller ?? _ownController)
          ?.removeListener(_onControllerChanged);
      _controller.addListener(_onControllerChanged);
    }
    if (oldWidget.focusNode != widget.focusNode) {
      (oldWidget.focusNode ?? _ownFocusNode)?.removeListener(_onFocusChanged);
      _focusNode.addListener(_onFocusChanged);
    }
  }

  @override
  void dispose() {
    _controller.removeListener(_onControllerChanged);
    _focusNode.removeListener(_onFocusChanged);
    _ownController?.dispose();
    _ownFocusNode?.dispose();
    super.dispose();
  }

  void _onControllerChanged() => setState(() {});

  void _onFocusChanged() => setState(() {});

  void _onChanged(String code) {
    widget.onChanged?.call(code);
    if (code.length < widget.length) {
      _completed = null;
    } else if (code != _completed) {
      _completed = code;
      widget.onCompleted?.call(code);
    }
  }

  /// A tap anywhere on the boxes edits from the END — the code is entered in
  /// order, never by inserting mid-way.
  void _onTap() {
    final int end = _controller.text.length;
    _controller.selection = TextSelection.collapsed(offset: end);
  }

  @override
  Widget build(BuildContext context) {
    final String code = _controller.text;
    final bool focused = _focusNode.hasFocus;
    final bool hasError = widget.errorText != null;
    // The box the next digit goes into; the last one while the code is full.
    final int active =
        code.length >= widget.length ? widget.length - 1 : code.length;

    final Widget boxes = Row(
      children: <Widget>[
        for (int i = 0; i < widget.length; i++) ...<Widget>[
          if (i > 0) const SizedBox(width: BbOtpInput.boxGap),
          Expanded(
            child: _OtpBox(
              index: i,
              digit: i < code.length ? code[i] : null,
              active: focused && widget.enabled && i == active,
              error: hasError,
              enabled: widget.enabled,
            ),
          ),
        ],
      ],
    );

    // The real input: transparent text, caret and selection over the boxes,
    // no fill of its own (the theme fills inputs), so only the boxes show.
    final Widget input = TextSelectionTheme(
      data: const TextSelectionThemeData(
        cursorColor: Colors.transparent,
        selectionColor: Colors.transparent,
        selectionHandleColor: Colors.transparent,
      ),
      child: TextField(
        key: widget.fieldKey,
        controller: _controller,
        focusNode: _focusNode,
        autofocus: widget.autofocus,
        enabled: widget.enabled,
        showCursor: false,
        keyboardType: TextInputType.number,
        textInputAction: TextInputAction.done,
        autofillHints: const <String>[AutofillHints.oneTimeCode],
        autocorrect: false,
        enableSuggestions: false,
        enableIMEPersonalizedLearning: false,
        inputFormatters: <TextInputFormatter>[
          _OtpCodeFormatter(widget.length),
        ],
        onChanged: _onChanged,
        onTap: _onTap,
        style: AppTypography.mono(
          size: AppTypography.sizeSm,
          color: Colors.transparent,
        ),
        decoration: const InputDecoration.collapsed(hintText: null),
      ),
    );

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        ConstrainedBox(
          constraints: BoxConstraints(
            maxWidth: widget.length * BbOtpInput.boxMaxWidth +
                (widget.length - 1) * BbOtpInput.boxGap,
          ),
          child: SizedBox(
            height: BbOtpInput.boxHeight,
            child: Semantics(
              label: widget.semanticLabel,
              child: Stack(
                children: <Widget>[
                  Positioned.fill(child: ExcludeSemantics(child: boxes)),
                  Positioned.fill(child: input),
                ],
              ),
            ),
          ),
        ),
        BbFieldError(text: widget.errorText),
      ],
    );
  }
}

/// One drawn box: its digit, the focus edge when it is next to fill, the
/// crimson edge on an error, and the pop as a digit lands.
class _OtpBox extends StatefulWidget {
  const _OtpBox({
    required this.index,
    required this.digit,
    required this.active,
    required this.error,
    required this.enabled,
  });

  final int index;
  final String? digit;
  final bool active;
  final bool error;
  final bool enabled;

  @override
  State<_OtpBox> createState() => _OtpBoxState();
}

class _OtpBoxState extends State<_OtpBox> with SingleTickerProviderStateMixin {
  late final AnimationController _pop = AnimationController(
    vsync: this,
    duration: AppMotion.press,
  );

  /// Up to [AppMotion.popScale] on the way in (ease-out), back to rest on the
  /// way down (ease-in) — one beat, never a loop.
  late final Animation<double> _scale = TweenSequence<double>(
    <TweenSequenceItem<double>>[
      TweenSequenceItem<double>(
        tween: Tween<double>(begin: 1, end: AppMotion.popScale)
            .chain(CurveTween(curve: AppMotion.easeOut)),
        weight: 1,
      ),
      TweenSequenceItem<double>(
        tween: Tween<double>(begin: AppMotion.popScale, end: 1)
            .chain(CurveTween(curve: AppMotion.easeIn)),
        weight: 1,
      ),
    ],
  ).animate(_pop);

  @override
  void didUpdateWidget(_OtpBox oldWidget) {
    super.didUpdateWidget(oldWidget);
    final String? digit = widget.digit;
    if (digit != null && digit != oldWidget.digit) {
      final Duration duration = AppMotion.resolve(context, AppMotion.press);
      if (duration == Duration.zero) return;
      _pop
        ..duration = duration
        ..forward(from: 0);
    }
  }

  @override
  void dispose() {
    _pop.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final BorderSide edge = widget.error
        ? BorderSide(color: AppColors.danger, width: widget.active ? 2 : 1)
        : widget.active
            ? const BorderSide(color: AppColors.blue, width: 2)
            : const BorderSide(color: AppColors.borderStrong);
    return ScaleTransition(
      key: BbOtpInput.boxKey(widget.index),
      scale: _scale,
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: AppColors.surfaceCard,
          borderRadius: BorderRadius.circular(AppRadii.md),
          border: Border.fromBorderSide(edge),
        ),
        child: Center(
          child: Text(
            widget.digit ?? '',
            style: AppTypography.mono(
              size: AppTypography.sizeLg,
              weight: FontWeight.w700,
              color: widget.enabled
                  ? AppColors.textPrimary
                  : AppColors.textMuted,
            ),
          ),
        ),
      ),
    );
  }
}

/// Digits only, at most `length` of them. A paste or autofill that brings a
/// whole code replaces what was there — even when the field was already full —
/// while one extra keystroke on a full field is refused. Keeps the caret at
/// the end, so digits are always entered in order.
class _OtpCodeFormatter extends TextInputFormatter {
  _OtpCodeFormatter(this.length);

  final int length;

  static final RegExp _nonDigit = RegExp(r'\D');

  @override
  TextEditingValue formatEditUpdate(
    TextEditingValue oldValue,
    TextEditingValue newValue,
  ) {
    String code = newValue.text.replaceAll(_nonDigit, '');
    if (code.length > length) {
      final String inserted =
          _inserted(oldValue.text, newValue.text).replaceAll(_nonDigit, '');
      if (inserted.length < length) return oldValue;
      code = inserted.substring(0, length);
    }
    return TextEditingValue(
      text: code,
      selection: TextSelection.collapsed(offset: code.length),
    );
  }

  /// The text [after] gained over [before] (the span between their common
  /// prefix and suffix) — what was typed or pasted.
  static String _inserted(String before, String after) {
    int start = 0;
    while (start < before.length &&
        start < after.length &&
        before.codeUnitAt(start) == after.codeUnitAt(start)) {
      start++;
    }
    int endBefore = before.length;
    int endAfter = after.length;
    while (endBefore > start &&
        endAfter > start &&
        before.codeUnitAt(endBefore - 1) == after.codeUnitAt(endAfter - 1)) {
      endBefore--;
      endAfter--;
    }
    return after.substring(start, endAfter);
  }
}
