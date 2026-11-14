import 'package:flutter/material.dart';

import '../theme/app_colors.dart';

/// The official BadaBhai two-person mark — a large yellow worker beside a
/// smaller ivory one — the same lockup the worker app shows.
///
/// The ivory figure is near-white, so on a light surface it needs a dark plate
/// to stay legible: the default draws the mark on a deep-blue disc. On a header
/// that is already blue (the auth bands) use [BbBrandMark.onBlue], which drops
/// the disc and lets the figures sit straight on the band.
class BbBrandMark extends StatelessWidget {
  const BbBrandMark({super.key, this.size = 72})
      : onBlue = false;

  const BbBrandMark.onBlue({super.key, this.size = 72}) : onBlue = true;

  final double size;
  final bool onBlue;

  /// The brand mark asset — also pinned by the auth brand tests.
  static const String asset = 'assets/brand/badabhai-mark.png';

  @override
  Widget build(BuildContext context) {
    final Widget mark = Image.asset(
      asset,
      fit: BoxFit.contain,
      filterQuality: FilterQuality.high,
      excludeFromSemantics: true,
    );
    return Semantics(
      label: 'BadaBhai',
      image: true,
      child: onBlue
          ? SizedBox(width: size, height: size, child: mark)
          : Container(
              width: size,
              height: size,
              padding: EdgeInsets.all(size * 0.16),
              decoration: const BoxDecoration(
                color: AppColors.blue,
                shape: BoxShape.circle,
              ),
              child: mark,
            ),
    );
  }
}
