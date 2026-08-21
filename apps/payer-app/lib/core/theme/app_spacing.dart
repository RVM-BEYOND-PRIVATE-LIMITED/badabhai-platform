/// BadaBhai spacing, sizing & radius tokens — ported from the design system's
/// `tokens/spacing.css` and `tokens/radii.css`.
///
/// 4px base grid. **Touch targets are sacred:** worker-app controls never drop
/// below 48px (`tap`) — gloved hands, low-end screens, the field. The primary
/// CTA is 52–54px.
class AppSpacing {
  AppSpacing._();

  // 4px grid
  static const double s0 = 0;
  static const double s1 = 4;
  static const double s2 = 8;
  static const double s3 = 12;
  static const double s4 = 16;
  static const double s5 = 20;
  static const double s6 = 24;
  static const double s7 = 32;
  static const double s8 = 40;
  static const double s9 = 48;
  static const double s10 = 64;
  static const double s11 = 80;
  static const double s12 = 96;

  // touch & control sizing
  static const double tap = 48; // minimum interactive height (worker app)
  static const double controlSm = 36;
  static const double controlMd = 44;
  static const double controlLg = 52; // primary worker CTA

  // layout rails
  static const double gutter = 20; // mobile screen padding
  static const double appMax = 440; // worker mobile canvas

  // Sub-grid gaps — off the 4px grid but design-intentional and repeated across
  // tight stacks (label→value, badge/chip rows). Named so the exact value is
  // referenced, never re-picked ad hoc (#1080). Do NOT snap these to the grid.
  static const double gap2 = 2;
  static const double gap3 = 3;
  static const double gap6 = 6;
  static const double chipGap = 7; // Wrap spacing between chips/badges

  // Fixed component dimensions — off-grid, exact pixel values (#1080). Kept
  // named rather than snapped so the original size is preserved verbatim.
  static const double brandMark = 56; // login brand tile (between s9=48/s10=64)
  static const double labelCol = 104; // fixed label column (draft preview)
}

/// Corner radii — JUL31 "rounded voice on a disciplined skeleton": **hard cap
/// 12** on the skeleton. Buttons/cards 10, chat bubble 12 (with a 3px flattened
/// tail corner), chips are the one exception — soft 14px pills (`rChip`).
class AppRadii {
  AppRadii._();

  static const double xs = 6;
  static const double sm = 10;
  static const double md = 10; // default control: button, input
  static const double lg = 10; // card
  static const double xl = 12; // sheet / large card (capped)
  static const double xxl = 12; // hero / bottom sheet (capped)

  // JUL31 kit radii (mirror tokens.dart: rChip / rBubble / rBubbleTail).
  static const double chip = 14; // chip pill — the one radius above the cap
  static const double bubble = 12; // chat bubble corners
  static const double bubbleTail = 3; // the flattened tail corner on a bubble

  static const double pill = 999;
}
