import 'package:flutter/widgets.dart';

import '../theme/app_spacing.dart';

/// The pinned action bar under a full-screen form (#2595, M7). Post a job and
/// both Edit screens share it, so the form's ONE primary action sits in the
/// same place with the same padding everywhere, and stays visible however tall
/// the form grows (a tall form used to push Edit's Save below the fold).
///
/// Pass it as `Scaffold.bottomNavigationBar`; it clears the system gesture
/// inset itself. Paints nothing of its own — the screen's canvas shows through.
class BbActionBar extends StatelessWidget {
  const BbActionBar({super.key, required this.child});

  /// The action — normally one block [BbButton].
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      top: false,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(
          AppSpacing.gutter,
          AppSpacing.s3,
          AppSpacing.gutter,
          AppSpacing.s3,
        ),
        child: child,
      ),
    );
  }
}
