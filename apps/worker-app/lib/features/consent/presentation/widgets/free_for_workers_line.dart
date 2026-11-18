import 'package:flutter/material.dart';

import '../../../../core/config/remote_config.dart';
import '../../../../core/widgets/kit/kit_callout.dart';

/// #2748 item 7a — the line itself. Neutral copy: no price, no amount.
const String kFreeForWorkersText = 'BadaBhai workers ke liye bilkul free hai.';

/// The "free for workers" line, on the sign-up (consent) screen and in
/// Settings.
///
/// NOT PART OF ANY NOTICE. Callers place it OUTSIDE the versioned notice
/// cards (the employer-sharing and voice notices), so the consent text a
/// worker certifies — and `kConsentVersion` with it — stays exactly as
/// approved.
///
/// Behind a Remote Config switch that ships OFF: callers draw it only when
/// [isVisible] says so.
class FreeForWorkersLine extends StatelessWidget {
  const FreeForWorkersLine({super.key});

  /// Whether the line is shown — [BbRemoteConfig.freeForWorkersLineVisible].
  static bool get isVisible =>
      BbRemoteConfig.instance.freeForWorkersLineVisible;

  @override
  Widget build(BuildContext context) {
    return const KitCallout(
      tileIcon: Icons.verified_rounded,
      text: kFreeForWorkersText,
    );
  }
}
