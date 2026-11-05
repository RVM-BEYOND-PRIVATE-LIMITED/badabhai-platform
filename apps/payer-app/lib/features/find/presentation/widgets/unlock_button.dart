import 'package:flutter/material.dart';

import '../../../../core/theme/app_haptics.dart';
import '../../../../core/widgets/bb_button.dart';
import '../../../../core/widgets/bb_shake.dart';

/// The card's unlock CTA copy (#2593). The spend itself ("1 credit", never a ₹
/// price — #2589) is stated by the confirm dialog this opens.
const String kUnlockLabel = 'Unlock';

/// The CTA on a card the payer has already unlocked.
const String kViewLabel = 'View';

/// How one unlock attempt ended — what the card's [UnlockButton] reacts to.
enum UnlockOutcome {
  /// The payer backed out of the confirm dialog: nothing was spent.
  cancelled,

  /// The server granted it; the card turns to "View".
  granted,

  /// The server's neutral refusal (no credit, a cap, unavailable).
  denied,

  /// The request never completed (an outage). The list stays; Retry is a tap.
  failed;

  /// The payer confirmed, and the unlock did not happen.
  bool get isFailure => this == denied || this == failed;
}

/// Find's unlock CTA (#2593) — the full-width footer of a candidate card:
/// "Unlock" with a lock icon.
///
/// ONE REQUEST PER TAP. [onUnlock] runs one whole attempt (the confirm dialog,
/// then the request) and the button ignores every tap until it settles. The
/// second tap of a double-tap lands before the dialog's barrier can catch it,
/// so without this lock it opened a second dialog — and a second spend.
///
/// While the request is in flight ([busy] — the cubit's word, so it outlives
/// the card scrolling out of the list and back) the lock icon gives way to an
/// inline spinner of the same size; the label stays, so the button never
/// changes width.
///
/// A failed attempt ([UnlockOutcome.isFailure]) gives the error haptic and
/// shakes the enclosing [BbShake] — the card — once (none under reduced motion).
class UnlockButton extends StatefulWidget {
  const UnlockButton({super.key, required this.onUnlock, this.busy = false});

  /// One attempt: the confirm dialog, then the request.
  final Future<UnlockOutcome> Function() onUnlock;

  /// A request for this card is in flight.
  final bool busy;

  @override
  State<UnlockButton> createState() => _UnlockButtonState();
}

class _UnlockButtonState extends State<UnlockButton> {
  /// An attempt is running. Set on the tap itself, before the dialog opens.
  bool _running = false;

  Future<void> _attempt() async {
    if (_running || widget.busy) return;
    setState(() => _running = true);
    final UnlockOutcome outcome;
    try {
      outcome = await widget.onUnlock();
    } finally {
      if (mounted) setState(() => _running = false);
    }
    if (!mounted || !outcome.isFailure) return;
    AppHaptics.error();
    context.findAncestorStateOfType<BbShakeState>()?.shake();
  }

  @override
  Widget build(BuildContext context) {
    // IgnorePointer, not a null handler: a disabled face would flash grey under
    // the dialog's scrim while the payer decides.
    return IgnorePointer(
      ignoring: _running,
      child: BbButton(
        label: kUnlockLabel,
        iconLeft: Icons.lock_rounded,
        // md (44px), the paid CTA's floor (#1082).
        size: BbButtonSize.md,
        block: true,
        loading: widget.busy,
        onPressed: _attempt,
      ),
    );
  }
}

/// The footer every Find card ends with (#2593): ONE full-width action under
/// the facts — [kViewLabel] once the worker is unlocked, else the
/// [UnlockButton]. It used to be a column squeezed beside the facts, which a
/// 360dp phone could not fit.
class CandidateCardAction extends StatelessWidget {
  const CandidateCardAction({
    super.key,
    required this.unlocked,
    required this.onUnlock,
    required this.onView,
    this.busy = false,
    this.viewIcon = Icons.chat_bubble_rounded,
  });

  final bool unlocked;

  /// One unlock attempt (see [UnlockButton.onUnlock]).
  final Future<UnlockOutcome> Function() onUnlock;
  final VoidCallback onView;

  /// An unlock for this card is in flight.
  final bool busy;

  /// The View button's icon — the relay chat on the real cards.
  final IconData viewIcon;

  @override
  Widget build(BuildContext context) {
    if (!unlocked) return UnlockButton(busy: busy, onUnlock: onUnlock);
    return BbButton(
      label: kViewLabel,
      size: BbButtonSize.md,
      iconLeft: viewIcon,
      block: true,
      onPressed: onView,
    );
  }
}
