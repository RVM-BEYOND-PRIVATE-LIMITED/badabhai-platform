/// Matching V1's bucketed month count as a COARSE human label (ADR-0036) — the
/// app's ONE months→years formatter.
///
/// A ported copy of payer-web's `monthsLabel` (`apps/payer-web/src/lib/
/// masking.ts`) so the web and the app print the same years for the same
/// worker. The stored number is already rounded DOWN to a 6-month bucket, so
/// "47 months" would put back exactly the precision the bucketing removed: this
/// reads whole years with a ".5" half-step and never claims more than the bucket
/// supports. It ALWAYS ROUNDS DOWN — a worker's own estimate is never inflated
/// on a screen a company pays to act on.
///
///   monthsLabel(48) == '4 yrs'
///   monthsLabel(54) == '4.5 yrs'
///   monthsLabel(6)  == '6 mo'
///   monthsLabel(12) == '1 yr'
///   monthsLabel(0)  == ''   (nothing to print — the caller decides)
String monthsLabel(int? months) {
  if (months == null || months <= 0) return '';
  if (months < 12) return '$months mo';
  final int years = months ~/ 12;
  final bool half = months % 12 >= 6;
  if (!half) return years == 1 ? '1 yr' : '$years yrs';
  return '$years.5 yrs';
}
