import 'package:flutter/material.dart';

import '../theme/app_spacing.dart';
import '../theme/bb_palette.dart';
import '../theme/onboarding_theme.dart';
import 'bb_toggle.dart';

/// Colour tone for a [BbListRow.notification] leading tile.
///
/// The NAMES are historical (they predate v3) but the tones are now assigned by
/// what the notification MEANS, not by decoration:
///
///  - [green]   — a good outcome the worker can act on (profile ready, an
///                application sent): success tint + green glyph.
///  - [saffron] — a SECURITY event (a new device, a PIN change): the error tint
///                + red glyph, because it is the one kind of alert a worker must
///                not scroll past.
///  - [brand]   — an informational nudge (a resume is ready to view, a voice
///                note is waiting): the informational blue tint + navy glyph.
///                This replaces a yellow glyph on a yellow tint, which failed
///                contrast outright.
enum BbNotiTone { green, saffron, brand }

/// The BadaBhai list row family — one widget, five named constructors that
/// cover the settings row, the notification row, the status line and the
/// interview-kit row.
///
/// All share a leading tile → middle title/subtitle → optional trailing
/// layout, kept DRY through a single private builder. Every tappable row clears
/// the 48px [OnboardingLayout.tapTarget] minimum touch target.
class BbListRow extends StatelessWidget {
  const BbListRow._({
    super.key,
    required this.leading,
    required this.title,
    this.subtitle,
    this.trailing,
    this.onTap,
    this.showBorder = true,
    this.padding = const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
  });

  final Widget leading;
  final Widget title;
  final Widget? subtitle;
  final Widget? trailing;
  final VoidCallback? onTap;
  final bool showBorder;
  final EdgeInsetsGeometry padding;

  /// A settings row: muted square icon tile, title + optional subtitle,
  /// chevron, hairline bottom border. `danger` paints it crimson.
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
        tone: danger ? _TileTone.danger : _TileTone.neutral,
      ),
      title: _RowTitle(title, danger: danger),
      subtitle: subtitle == null ? null : _RowSubtitle(subtitle),
      trailing: const _Chevron(),
    );
  }

  /// A settings row whose trailing affordance is a [BbToggle] slide switch (not
  /// a chevron). Tapping anywhere on the row flips it, same as the switch. Used
  /// for on/off preferences (e.g. Notifications).
  factory BbListRow.toggle({
    Key? key,
    required IconData icon,
    required String title,
    String? subtitle,
    required bool value,
    required ValueChanged<bool> onChanged,
    bool enabled = true,
  }) {
    return BbListRow._(
      key: key,
      onTap: enabled ? () => onChanged(!value) : null,
      leading: _IconTile(icon: icon),
      title: _RowTitle(title),
      subtitle: subtitle == null ? null : _RowSubtitle(subtitle),
      trailing: BbToggle(
        value: value,
        onChanged: enabled ? onChanged : (_) {},
        semanticLabel: title,
      ),
    );
  }

  /// A notification row: tone-coloured square icon tile, title + subtitle, and
  /// a faint time stamp trailing.
  factory BbListRow.notification({
    Key? key,
    required IconData icon,
    required BbNotiTone tone,
    required String title,
    required String subtitle,
    required String time,
  }) {
    final _TileTone tileTone = switch (tone) {
      BbNotiTone.green => _TileTone.success,
      BbNotiTone.saffron => _TileTone.danger,
      BbNotiTone.brand => _TileTone.info,
    };
    return BbListRow._(
      key: key,
      leading: _IconTile(icon: icon, tone: tileTone),
      title: _RowTitle(title),
      subtitle: _RowSubtitle(subtitle),
      trailing: _RowTime(time),
    );
  }

  /// A status line: circular tone icon, bold label + muted state. No border
  /// (the composing screen supplies its own dividers).
  factory BbListRow.status({
    Key? key,
    required IconData icon,
    required bool green,
    required String label,
    required String state,
  }) {
    return BbListRow._(
      key: key,
      showBorder: false,
      leading: _IconTile(
        icon: icon,
        radius: AppRadii.pill,
        tone: green ? _TileTone.success : _TileTone.info,
      ),
      title: _RowTitle(label),
      subtitle: _RowSubtitle(state),
    );
  }

  /// An interview-kit row: a square tile (colours overridable), an Anek title +
  /// muted subtitle, chevron, tappable.
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
        size: 44,
        tone: _TileTone.brand,
        background: iconBg,
        iconColor: iconColor,
      ),
      title: Text(
        title,
        style: OnboardingTypography.anek(size: 15, weight: FontWeight.w700),
      ),
      subtitle: _RowSubtitle(subtitle),
      trailing: const _Chevron(),
    );
  }

  @override
  Widget build(BuildContext context) {
    final BbPalette p = context.bb;
    final Widget row = Padding(
      padding: padding,
      child: Row(
        children: <Widget>[
          leading,
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisAlignment: MainAxisAlignment.center,
              children: <Widget>[
                title,
                if (subtitle != null) ...<Widget>[
                  const SizedBox(height: 2),
                  subtitle!,
                ],
              ],
            ),
          ),
          if (trailing != null) ...<Widget>[
            const SizedBox(width: 12),
            trailing!,
          ],
        ],
      ),
    );

    final Widget bounded = ConstrainedBox(
      constraints: const BoxConstraints(minHeight: OnboardingLayout.tapTarget),
      child: Center(child: row),
    );

    final Widget bordered = showBorder
        ? DecoratedBox(
            decoration: BoxDecoration(
              border: Border(bottom: BorderSide(color: p.borderSubtle)),
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

/// The row's trailing chevron.
class _Chevron extends StatelessWidget {
  const _Chevron();

  @override
  Widget build(BuildContext context) {
    return Icon(Icons.chevron_right_rounded, color: context.bb.textMuted);
  }
}

/// A row title. `danger` paints it crimson; the default is the primary ink.
///
/// A single long word gets ONE step of shrink rather than a mid-word break: at
/// the 2.0 ceiling 'Notifications' came out as 'Notificati / ons', which reads
/// as a rendering fault to a worker who is sounding the word out. scaleDown is
/// inert at every size where the word fits.
class _RowTitle extends StatelessWidget {
  const _RowTitle(this.text, {this.danger = false});

  final String text;
  final bool danger;

  @override
  Widget build(BuildContext context) {
    final BbPalette p = context.bb;
    return FittedBox(
      fit: BoxFit.scaleDown,
      alignment: Alignment.centerLeft,
      child: Text(
        text,
        style: OnboardingTypography.inter(
          size: 14,
          weight: FontWeight.w600,
          color: danger ? p.danger : p.textPrimary,
        ),
      ),
    );
  }
}

/// A row's muted supporting line.
class _RowSubtitle extends StatelessWidget {
  const _RowSubtitle(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    return Text(
      text,
      style: OnboardingTypography.inter(
        size: 12,
        color: context.bb.textSecondary,
      ),
    );
  }
}

/// A row's faint trailing time stamp.
class _RowTime extends StatelessWidget {
  const _RowTime(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    return Text(
      text,
      style: OnboardingTypography.inter(
        size: 11,
        color: context.bb.textMuted,
      ),
    );
  }
}

enum _TileTone { neutral, danger, success, info, brand }

/// Square (or circular, at [AppRadii.pill]) icon tile shared by every row.
///
/// Deliberately ONE Container: the notifications screen test reads the tile's
/// fill off the Icon's nearest Container ancestor.
class _IconTile extends StatelessWidget {
  const _IconTile({
    required this.icon,
    this.tone = _TileTone.neutral,
    this.background,
    this.iconColor,
    this.size = 40,
    this.radius = 8,
  });

  final IconData icon;
  final _TileTone tone;
  final Color? background;
  final Color? iconColor;
  final double size;
  final double radius;

  @override
  Widget build(BuildContext context) {
    final BbPalette p = context.bb;
    final (Color bg, Color fg) = switch (tone) {
      _TileTone.neutral => (p.inset, p.textSecondary),
      _TileTone.danger => (p.dangerBg, p.danger),
      _TileTone.success => (p.successBg, p.success),
      _TileTone.info => (p.infoBg, p.textBrand),
      _TileTone.brand => (p.inset, p.textBrand),
    };
    return Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: background ?? bg,
        borderRadius: BorderRadius.circular(radius),
      ),
      child: Icon(icon, color: iconColor ?? fg, size: size * 0.5),
    );
  }
}
