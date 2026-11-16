import 'package:flutter/material.dart';
import '../../../../core/theme/bb_palette.dart';
import 'package:flutter/services.dart';

import '../../../../core/theme/onboarding_theme.dart';
import '../../../../core/widgets/feedback_fab.dart';
import '../../../../core/widgets/kit/kit_content_column.dart';
import '../../../../core/widgets/onboarding/option_icons.dart';
import '../../domain/interview_kit.dart';

/// INTERVIEW KIT — the list screen drawn from
/// `assets/fonts/image/interview_kit.png` (Profile → Interview kit).
///
/// RENDER ONLY. Every fact shown is caller-supplied REAL data:
///
///  - the header title ([InterviewKitHeader.title]) and the tip
///    ([InterviewKitTipCard]) are the design's own static chrome, not per-worker
///    data;
///  - each card's title/subtitle is the server's `display_name` + the honest
///    subtitle the repository builds — the list route carries NO per-kit counts
///    or badges, so none are invented here;
///  - the tile's glyph and pastel are DERIVED from the trade (see
///    [_kitTileStyle]) — no icon or badge is claimed as a fact about the kit.
///
/// The design's horizontal trade chips and the dark "Aapka Trade" card are
/// deliberately NOT drawn (owner ruling on the mock): this screen is the header
/// + search + available-kits list + tip.

// ---- design literals, measured off the mock -------------------------------
//
// The mock is P3-shifted like the others: the navy equals [shiftBlue] and the
// yellows equal [safetyYellow] once the shift is undone, so those are NOT
// redefined. Only the values the token layer does not carry are named here.

/// The header's geometry, in dp at the mock's scale.
const double _kHeaderGutter = 16;
const double _kHeaderBottomRadius = 16;
const double _kHeaderRowHeight = OnboardingLayout.tapTarget;
const double _kBackCircle = 42;
const double _kTitleDot = 7;
const double _kTitleRuleWidth = 52;
const double _kTitleRuleHeight = 3.5;
const double _kSearchHeight = OnboardingLayout.tapTarget;
const double _kSearchRadius = 14;

/// The kit card's geometry.
const double _kCardRadius = OnboardingRadii.card;
const double _kTileSize = 44;
const double _kTileRadius = 14;
const double _kChevronCircle = 34;

/// The navy header: a circular back disc, the centred title with its yellow
/// dot + rule, and — once the list is ready — the search row.
///
/// Chrome, so it clamps text scaling at [OnboardingLayout.chromeMaxTextScale]
/// like every other header, and caps its inner column at
/// [OnboardingLayout.maxTabContentWidth] so a tablet does not stretch it.
class InterviewKitHeader extends StatelessWidget {
  const InterviewKitHeader({
    super.key,
    required this.onBack,
    this.search,
  });

  static const String title = 'Interview Kit';

  final VoidCallback onBack;

  /// The search row. Null while the list is loading / failed — a search box
  /// that cannot filter anything is a dead control.
  final Widget? search;

  @override
  Widget build(BuildContext context) {
    final BbPalette p = context.bb;
    final double top = MediaQuery.paddingOf(context).top;
    return AnnotatedRegion<SystemUiOverlayStyle>(
      value: SystemUiOverlayStyle.light,
      child: MediaQuery.withClampedTextScaling(
        maxScaleFactor: OnboardingLayout.chromeMaxTextScale,
        child: Container(
          width: double.infinity,
          decoration: BoxDecoration(
            color: p.brandSurface,
            borderRadius: BorderRadius.vertical(
              bottom: Radius.circular(_kHeaderBottomRadius),
            ),
          ),
          padding: EdgeInsets.only(
            top: top + 8,
            left: _kHeaderGutter,
            right: _kHeaderGutter,
            bottom: 16,
          ),
          child: KitContentColumn(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                // The title is centred on the SCREEN (as the mock draws it), not
                // on the space the back control leaves — so back is laid over it
                // in a Stack rather than competing in a Row. The 48dp side pads
                // keep the title clear of the control.
                SizedBox(
                  height: _kHeaderRowHeight,
                  child: Stack(
                    alignment: Alignment.center,
                    children: <Widget>[
                      const Padding(
                        padding: EdgeInsets.symmetric(
                          horizontal: _kHeaderRowHeight,
                        ),
                        child: _TitleBlock(),
                      ),
                      Align(
                        alignment: Alignment.centerLeft,
                        child: _CircleBackButton(onBack: onBack),
                      ),
                    ],
                  ),
                ),
                if (search != null) ...<Widget>[
                  const SizedBox(height: 14),
                  search!,
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// "Interview Kit" + the yellow status dot, over the yellow rule.
class _TitleBlock extends StatelessWidget {
  const _TitleBlock();

  @override
  Widget build(BuildContext context) {
    final BbPalette p = context.bb;
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Row(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Flexible(
              child: Text(
                InterviewKitHeader.title,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: OnboardingTypography.anek(
                  size: 20,
                  weight: FontWeight.w800,
                  // A deterministic line box: the title, its 6dp gap and the
                  // rule must fit the header row's fixed 48 at the 1.3 chrome
                  // clamp, and the font's own leading is 0.5dp over that.
                  height: 1.2,
                  color: p.onBrandSurface,
                ),
              ),
            ),
            const SizedBox(width: 6),
            Container(
              width: _kTitleDot,
              height: _kTitleDot,
              decoration:  BoxDecoration(
                color: p.action,
                shape: BoxShape.circle,
              ),
            ),
          ],
        ),
        const SizedBox(height: 6),
        Container(
          width: _kTitleRuleWidth,
          height: _kTitleRuleHeight,
          decoration: BoxDecoration(
            color: p.action,
            borderRadius: BorderRadius.circular(2),
          ),
        ),
      ],
    );
  }
}

/// The mock's circular back control: a navy disc on the navy header, inside the
/// 48dp tap floor the disc itself is too small to meet.
class _CircleBackButton extends StatelessWidget {
  const _CircleBackButton({required this.onBack});

  final VoidCallback onBack;

  @override
  Widget build(BuildContext context) {
    final BbPalette p = context.bb;
    return Tooltip(
      message: 'Wapas',
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: onBack,
          customBorder: const CircleBorder(),
          child: SizedBox(
            width: OnboardingLayout.tapTarget,
            height: OnboardingLayout.tapTarget,
            child: Center(
              child: Container(
                width: _kBackCircle,
                height: _kBackCircle,
                decoration: BoxDecoration(
                  color: p.brandSurfaceRaised,
                  shape: BoxShape.circle,
                ),
                child:  Icon(
                  Icons.chevron_left_rounded,
                  size: 26,
                  color: p.onBrandSurface,
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// The white search row: a real field the caller owns, plus a clear control
/// once text exists.
class InterviewKitSearchField extends StatelessWidget {
  const InterviewKitSearchField({
    super.key,
    required this.controller,
    required this.onChanged,
    required this.onClear,
  });

  static const String hint = 'Profile ke naam se';

  final TextEditingController controller;
  final ValueChanged<String> onChanged;
  final VoidCallback onClear;

  @override
  Widget build(BuildContext context) {
    final BbPalette p = context.bb;
    return Container(
      height: _kSearchHeight,
      padding: const EdgeInsets.only(left: 12, right: 6),
      decoration: BoxDecoration(
        color: p.card,
        borderRadius: BorderRadius.circular(_kSearchRadius),
      ),
      child: Row(
        children: <Widget>[
           Icon(
            Icons.search_rounded,
            size: 20,
            color: p.textMuted,
          ),
          const SizedBox(width: 8),
          Expanded(
            child: TextField(
              key: const Key('kitSearchField'),
              controller: controller,
              onChanged: onChanged,
              textInputAction: TextInputAction.search,
              // `expands` so the editable area fills the field's 48dp box: the
              // render object is what a screen reader reports as tappable, and
              // a bare one-line field measured 21dp against the 48dp floor.
              expands: true,
              maxLines: null,
              minLines: null,
              textAlignVertical: TextAlignVertical.center,
              style: OnboardingTypography.inter(
                size: 14,
                weight: FontWeight.w500,
                color: p.textPrimary,
              ),
              // The app-wide InputDecorationTheme paints an outline on every
              // field, and `InputDecoration.collapsed` only clears `border` —
              // the theme's enabled/focused borders still landed on this box.
              // This field draws its own white pill, so EVERY border slot is
              // explicitly none, focused included.
              decoration: InputDecoration(
                filled: false,
                isCollapsed: true,
                contentPadding: EdgeInsets.zero,
                border: InputBorder.none,
                enabledBorder: InputBorder.none,
                focusedBorder: InputBorder.none,
                disabledBorder: InputBorder.none,
                errorBorder: InputBorder.none,
                focusedErrorBorder: InputBorder.none,
                hintText: hint,
                hintStyle: OnboardingTypography.inter(
                  size: 14,
                  color: p.textMuted,
                ),
              ),
            ),
          ),
          // Only while there is text to clear — never permanent chrome.
          if (controller.text.isNotEmpty)
            IconButton(
              tooltip: 'Search saaf karein',
              padding: EdgeInsets.zero,
              constraints: const BoxConstraints.tightFor(
                width: OnboardingLayout.tapTarget,
                height: OnboardingLayout.tapTarget,
              ),
              onPressed: onClear,
              icon:  Icon(
                Icons.close_rounded,
                size: 18,
                color: p.textMuted,
              ),
            ),
        ],
      ),
    );
  }
}

/// "AVAILABLE TRADE KITS" with the muted "Tap to open syllabus" note.
class InterviewKitSectionHeader extends StatelessWidget {
  const InterviewKitSectionHeader({super.key});

  static const String label = 'AVAILABLE TRADE KITS';
  static const String trailing = 'Tap to open syllabus';

  @override
  Widget build(BuildContext context) {
    final BbPalette p = context.bb;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.end,
      children: <Widget>[
        Expanded(
          child: Text(
            label,
            style: OnboardingTypography.inter(
              size: 11,
              weight: FontWeight.w800,
              letterSpacing: 0.8,
              color: p.brandSurface,
            ),
          ),
        ),
        const SizedBox(width: 8),
        Flexible(
          child: Text(
            trailing,
            textAlign: TextAlign.right,
            style: OnboardingTypography.inter(
              size: 12.5,
              weight: FontWeight.w500,
              color: p.textMuted,
            ),
          ),
        ),
      ],
    );
  }
}

/// One available kit: the derived icon tile, the REAL title + subtitle, and the
/// chevron disc. The whole card is the tap target — no separate chevron button.
class InterviewKitCard extends StatelessWidget {
  const InterviewKitCard({
    super.key,
    required this.tradeKey,
    required this.title,
    required this.subtitle,
    required this.onTap,
  });

  final String tradeKey;
  final String title;
  final String subtitle;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final BbPalette p = context.bb;
    final _KitTileStyle tile = _kitTileStyle(tradeKey, title, p);
    return Semantics(
      button: true,
      label: '$title, $subtitle',
      child: Material(
        color: p.card,
        borderRadius: BorderRadius.circular(_kCardRadius),
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(_kCardRadius),
          child: Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(_kCardRadius),
              border: Border.all(color: p.borderDefault),
            ),
            child: Row(
              children: <Widget>[
                Container(
                  width: _kTileSize,
                  height: _kTileSize,
                  decoration: BoxDecoration(
                    color: tile.bg,
                    borderRadius: BorderRadius.circular(_kTileRadius),
                  ),
                  child: Icon(tile.icon, size: 22, color: tile.fg),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: <Widget>[
                      Text(
                        title,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: OnboardingTypography.anek(
                          size: 16,
                          weight: FontWeight.w800,
                          color: p.brandSurface,
                        ),
                      ),
                      const SizedBox(height: 3),
                      Text(
                        subtitle,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: OnboardingTypography.inter(
                          size: 13,
                          color: p.textMuted,
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 8),
                Container(
                  width: _kChevronCircle,
                  height: _kChevronCircle,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    border: Border.all(color: p.borderDefault),
                  ),
                  child:  Icon(
                    Icons.chevron_right_rounded,
                    size: 20,
                    color: p.textSecondary,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// The design's static interview tip — advice copy, not per-worker data.
class InterviewKitTipCard extends StatelessWidget {
  const InterviewKitTipCard({super.key});

  static const String title = 'Interview Tip: Confidence & Safety Marks';
  static const String body =
      'Factory HR sabse pehle Safety Shoes aur basic 5S rules ka dhyan '
      'dekhte hain. Interview se pehle documents file zaroor arrange rakhein.';

  @override
  Widget build(BuildContext context) {
    final BbPalette p = context.bb;
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: p.selectedCardBg,
        borderRadius: BorderRadius.circular(_kCardRadius),
        border: Border.all(color: p.action.withValues(alpha: 0.3)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Container(
            width: 36,
            height: 36,
            decoration: BoxDecoration(
              color: p.action.withValues(alpha: 0.25),
              borderRadius: BorderRadius.circular(12),
            ),
            child:  Icon(
              Icons.lightbulb_rounded,
              size: 20,
              color: p.haldi,
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                Text(
                  title,
                  style: OnboardingTypography.inter(
                    size: 13,
                    weight: FontWeight.w700,
                    color: p.textPrimary,
                  ),
                ),
                const SizedBox(height: 3),
                Text(
                  body,
                  style: OnboardingTypography.inter(
                    size: 13,
                    height: 1.45,
                    color: p.textSecondary,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// The ready body: the section header, the REAL kit cards (or an honest empty
/// state), and the tip.
class InterviewKitListView extends StatelessWidget {
  const InterviewKitListView({
    super.key,
    required this.items,
    required this.filtering,
    required this.onOpenKit,
    required this.onClearSearch,
  });

  /// Already filtered by the caller's search text.
  final List<KitListItem> items;

  /// True when [items] is the result of a non-empty search — the empty state
  /// then says "no match", not "no kits exist".
  final bool filtering;

  final ValueChanged<String> onOpenKit;
  final VoidCallback onClearSearch;

  static const String emptyCatalogue =
      'Abhi koi interview kit available nahi. Thodi der baad dekhein.';
  static const String emptySearch =
      'Is naam ki koi kit nahi mili. Doosra naam likhkar dekhein.';

  @override
  Widget build(BuildContext context) {
    final EdgeInsets side = KitInsets.list(
      MediaQuery.sizeOf(context).width,
      max: OnboardingLayout.maxTabContentWidth,
      gutter: 16,
    );
    return ListView(
      padding: EdgeInsets.fromLTRB(
        side.left,
        16,
        side.right,
        // Plus the floating Feedback pill's band, so it floats over empty
        // canvas rather than the last row. See [FeedbackFabInset].
        24 + FeedbackFabInset.of(context),
      ),
      children: <Widget>[
        const InterviewKitSectionHeader(),
        const SizedBox(height: 12),
        if (items.isEmpty)
          _EmptyKits(filtering: filtering, onClearSearch: onClearSearch)
        else
          for (int i = 0; i < items.length; i++) ...<Widget>[
            if (i > 0) const SizedBox(height: 12),
            InterviewKitCard(
              tradeKey: items[i].tradeKey,
              title: items[i].title,
              subtitle: items[i].subtitle,
              onTap: () => onOpenKit(items[i].tradeKey),
            ),
          ],
        const SizedBox(height: 16),
        const InterviewKitTipCard(),
      ],
    );
  }
}

/// The two honest empty states: an empty catalogue, and a search that matched
/// nothing (which the worker can clear).
class _EmptyKits extends StatelessWidget {
  const _EmptyKits({required this.filtering, required this.onClearSearch});

  final bool filtering;
  final VoidCallback onClearSearch;

  @override
  Widget build(BuildContext context) {
    final BbPalette p = context.bb;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Text(
          filtering
              ? InterviewKitListView.emptySearch
              : InterviewKitListView.emptyCatalogue,
          style: OnboardingTypography.bodyMuted(
            color: p.textMuted,
          ),
        ),
        if (filtering) ...<Widget>[
          const SizedBox(height: 8),
          TextButton(
            onPressed: onClearSearch,
            child: const Text('Search saaf karein'),
          ),
        ],
      ],
    );
  }
}

/// A kit tile's drawing: its glyph plus the pastel pair behind / on it.
class _KitTileStyle {
  const _KitTileStyle(this.icon, this.bg, this.fg);

  final IconData icon;
  final Color bg;
  final Color fg;
}

// The six tone families the mock draws, in its own order. Each is expressed in
// theme roles so the tiles follow the light/ink switch.
class _TileColors {
  const _TileColors(this.bg, this.fg);
  final Color bg;
  final Color fg;
}

_TileColors _tileBlue(BbPalette p) => _TileColors(p.infoBg, p.infoTitle);
_TileColors _tileCream(BbPalette p) =>
    _TileColors(p.selectedCardBg, p.warning);
_TileColors _tileLavender(BbPalette p) =>
    _TileColors(p.shieldCircle, p.link);
_TileColors _tileMint(BbPalette p) => _TileColors(p.successBg, p.success);
_TileColors _tilePeach(BbPalette p) => _TileColors(p.actionTint, p.warning);
_TileColors _tileRose(BbPalette p) => _TileColors(p.dangerBg, p.danger);

typedef _TileTone = _TileColors Function(BbPalette p);

const Map<String, IconData> _kTradeIcons = <String, IconData>{
  'cnc_operator': Icons.build_outlined,
  'vmc_operator': Icons.settings_outlined,
  'cnc_vmc_setter': Icons.tune_rounded,
  'cnc_programmer': Icons.code_rounded,
  'vmc_programmer': Icons.terminal_rounded,
  'cad_designer': Icons.architecture_rounded,
  'solidworks_designer': Icons.view_in_ar_outlined,
  'autocad_draftsman': Icons.description_outlined,
  'quality_inspector': Icons.verified_outlined,
  'production_engineer': Icons.bolt_rounded,
  'maintenance_technician': Icons.handyman_outlined,
  'tool_room_technician': Icons.construction_rounded,
  'machine_operator': Icons.precision_manufacturing_outlined,
  'assembly_technician': Icons.extension_outlined,
  'fitter': Icons.hardware_outlined,
};

const Map<String, _TileTone> _kTradeTones = <String, _TileTone>{
  'cnc_operator': _tileBlue,
  'vmc_operator': _tileCream,
  'cnc_vmc_setter': _tileBlue,
  'cnc_programmer': _tileLavender,
  'vmc_programmer': _tileLavender,
  'cad_designer': _tileLavender,
  'solidworks_designer': _tileLavender,
  'autocad_draftsman': _tileBlue,
  'quality_inspector': _tileMint,
  'production_engineer': _tilePeach,
  'maintenance_technician': _tileRose,
  'tool_room_technician': _tilePeach,
  'machine_operator': _tilePeach,
  'assembly_technician': _tileMint,
  'fitter': _tileBlue,
};

/// The tile for a kit. Known trade keys draw their own rule; anything the
/// catalogue adds later falls back to the shared option-icon rules and a tone
/// picked deterministically from the key — always an icon, never a blank tile.
_KitTileStyle _kitTileStyle(String tradeKey, String title, BbPalette p) {
  final _TileTone? tone = _kTradeTones[tradeKey];
  final IconData icon =
      _kTradeIcons[tradeKey] ??
      iconForOption(optionKey: tradeKey, label: title);
  if (tone != null) {
    final _TileColors colors = tone(p);
    return _KitTileStyle(icon, colors.bg, colors.fg);
  }
  const List<_TileTone> tones = <_TileTone>[
    _tileBlue,
    _tileCream,
    _tileLavender,
    _tileMint,
    _tilePeach,
    _tileRose,
  ];
  int sum = 0;
  for (final int unit in tradeKey.codeUnits) {
    sum += unit;
  }
  final _TileColors colors = tones[sum % tones.length](p);
  return _KitTileStyle(icon, colors.bg, colors.fg);
}
