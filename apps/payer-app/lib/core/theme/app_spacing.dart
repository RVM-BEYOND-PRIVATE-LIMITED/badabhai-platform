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
}

/// Corner radii — friendly but sturdy. Controls 14, cards 18, sheets 24; pills
/// for chips/status/swipe affordances. Ported from `tokens/radii.css`.
class AppRadii {
  AppRadii._();

  static const double xs = 6;
  static const double sm = 10;
  static const double md = 14; // default control: button, input
  static const double lg = 18; // card
  static const double xl = 24; // sheet / large card
  static const double xxl = 32; // hero / bottom sheet
  static const double pill = 999;
}
