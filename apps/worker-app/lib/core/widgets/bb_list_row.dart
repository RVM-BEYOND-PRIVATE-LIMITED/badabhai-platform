import 'package:flutter/material.dart';

import '../theme/app_colors.dart';
import '../theme/app_spacing.dart';
import '../theme/app_typography.dart';

/// Colour tone for a [BbListRow.notification] leading tile.
///
///  - [green]   — go / success (a new job, an applied confirmation).
///  - [saffron] — haldi warmth (reminders, kit-style nudges).
///  - [brand]   — vermilion brand moments.
enum BbNotiTone { green, saffron, brand }

/// The BadaBhai list row family — one widget, four named constructors that
/// cover the design system's `.aw-srow` (settings), `.aw-noti` (notification),
/// `.aw-status-row` (status) and `.aw-kitrow` (interview-kit) patterns.
///
/// All four share a leading tile → middle title/subtitle → optional trailing
/// layout, kept DRY through a single private builder. Every tappable row clears
/// the 48px [AppSpacing.tap] minimum touch target.
class BbListRow extends StatelessWidget {
  const BbListRow._({
    super.key,
    required this.leading,
    required this.title,
    this.subtitle,
    this.trailing,
    this.onTap,
    this.showBorder = true,
    this.padding = const EdgeInsets.symmetric(
      horizontal: AppSpacing.s4,
      vertical: AppSpacing.s3,
    ),
  });

  final Widget leading;
  final Widget title;
  final Widget? subtitle;
  final Widget? trailing;
  final VoidCallback? onTap;
  final bool showBorder;
  final EdgeInsetsGeometry padding;

  /// `.aw-srow` — a settings row: muted square icon tile, title + optional
  /// subtitle, chevron, hairline bottom border. `danger` paints it crimson.
  factory BbListRow.setting({
    Key? key,
    required IconData icon,
    required String title,
    String? subtitle,
    VoidCallback? onTap,
    bool danger = false,
  }) {
    return BbListRow._(
      key: key,
      onTap: onTap,
      leading: _IconTile(
        icon: icon,
        size: 38,
        radius: AppRadii.sm,
        background: danger ? AppColors.dangerTint : AppColors.surfaceSunken,
        iconColor: danger ? AppColors.danger : AppColors.textSecondary,
      ),
      title: Text(
        title,
        style: AppTypography.body(
          size: AppTypography.sizeBase,
          weight: FontWeight.w600,
          color: danger ? AppColors.danger : AppColors.textPrimary,
        ),
      ),
      subtitle: subtitle == null
          ? null
          : Text(
              subtitle,
              style: AppTypography.body(
                size: AppTypography.sizeXs,
                color: AppColors.textMuted,
              ),
            ),
      trailing: const Icon(
        Icons.chevron_right,
        color: AppColors.textFaint,
      ),
    );
  }

  /// `.aw-noti` — a notification row: tone-coloured square icon tile, title +
  /// subtitle, and a faint time stamp trailing.
  factory BbListRow.notification({
    Key? key,
    required IconData icon,
    required BbNotiTone tone,
    required String title,
    required String subtitle,
    required String time,
  }) {
    final (Color background, Color iconColor) = switch (tone) {
      BbNotiTone.green => (AppColors.successTint, AppColors.success),
      BbNotiTone.saffron => (AppColors.saffron100, AppColors.saffron700),
      BbNotiTone.brand => (AppColors.brandTint, AppColors.brand),
    };
    return BbListRow._(
      key: key,
      leading: _IconTile(
        icon: icon,
        size: 40,
        radius: AppRadii.md,
        background: background,
        iconColor: iconColor,
      ),
      title: Text(
        title,
        style: AppTypography.body(
          size: AppTypography.sizeSm,
          weight: FontWeight.w700,
          color: AppColors.textPrimary,
        ),
      ),
      subtitle: Text(
        subtitle,
        style: AppTypography.body(
          size: AppTypography.sizeXs,
          color: AppColors.textSecondary,
        ),
      ),
      trailing: Text(
        time,
        style: AppTypography.body(
          size: AppTypography.size2xs,
          color: AppColors.textFaint,
        ),
      ),
    );
  }

  /// `.aw-status-row` — a status line: circular tone icon, bold label + muted
  /// state. No border (the composing screen supplies its own dividers).
  factory BbListRow.status({
    Key? key,
    required IconData icon,
    required bool green,
    required String label,
    required String state,
  }) {
    final Color background =
        green ? AppColors.successTint : AppColors.saffron100;
    final Color iconColor = green ? AppColors.success : AppColors.saffron700;
    return BbListRow._(
      key: key,
      showBorder: false,
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.s4,
        vertical: AppSpacing.s3,
      ),
      leading: _IconTile(
        icon: icon,
        size: 40,
        radius: AppRadii.pill,
        background: background,
        iconColor: iconColor,
      ),
      title: Text(
        label,
        style: AppTypography.body(
          size: AppTypography.sizeSm,
          weight: FontWeight.w700,
          color: AppColors.textPrimary,
        ),
      ),
      subtitle: Text(
        state,
        style: AppTypography.body(
          size: AppTypography.sizeXs,
          color: AppColors.textMuted,
        ),
      ),
    );
  }

  /// `.aw-kitrow` — an interview-kit row: large saffron square tile (colours
  /// overridable), Baloo 2 title + muted subtitle, chevron, tappable.
  factory BbListRow.kit({
    Key? key,
    required IconData icon,
    required String title,
    required String subtitle,
    VoidCallback? onTap,
    Color? iconBg,
    Color? iconColor,
  }) {
    return BbListRow._(
      key: key,
      onTap: onTap,
      showBorder: false,
      padding: const EdgeInsets.all(15),
      leading: _IconTile(
        icon: icon,
        size: 46,
        radius: AppRadii.md,
        background: iconBg ?? AppColors.saffron100,
        iconColor: iconColor ?? AppColors.saffron700,
      ),
      title: Text(
        title,
        style: AppTypography.display(
          size: AppTypography.sizeBase,
          weight: FontWeight.w700,
        ),
      ),
      subtitle: Text(
        subtitle,
        style: AppTypography.body(
          size: AppTypography.sizeSm,
          color: AppColors.textMuted,
        ),
      ),
      trailing: const Icon(
        Icons.chevron_right,
        color: AppColors.textFaint,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final Widget row = Padding(
      padding: padding,
      child: Row(
        children: <Widget>[
          leading,
          const SizedBox(width: AppSpacing.s3),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisAlignment: MainAxisAlignment.center,
              children: <Widget>[
                title,
                if (subtitle != null) ...<Widget>[
                  const SizedBox(height: AppSpacing.s1 / 2),
                  subtitle!,
                ],
              ],
            ),
          ),
          if (trailing != null) ...<Widget>[
            const SizedBox(width: AppSpacing.s3),
            trailing!,
          ],
        ],
      ),
    );

    final Widget bounded = ConstrainedBox(
      constraints: const BoxConstraints(minHeight: AppSpacing.tap),
      child: Center(child: row),
    );

    final Widget bordered = showBorder
        ? DecoratedBox(
            decoration: const BoxDecoration(
              border: Border(
                bottom: BorderSide(color: AppColors.divider),
              ),
            ),
            child: bounded,
          )
        : bounded;

    if (onTap == null) {
      return bordered;
    }
    return Material(
      type: MaterialType.transparency,
      child: InkWell(onTap: onTap, child: bordered),
    );
  }
}

/// Square (or circular, at [AppRadii.pill]) icon tile shared by every row.
class _IconTile extends StatelessWidget {
  const _IconTile({
    required this.icon,
    required this.size,
    required this.radius,
    required this.background,
    required this.iconColor,
  });

  final IconData icon;
  final double size;
  final double radius;
  final Color background;
  final Color iconColor;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        color: background,
        borderRadius: BorderRadius.circular(radius),
      ),
      alignment: Alignment.center,
      child: Icon(icon, color: iconColor, size: size * 0.5),
    );
  }
}
