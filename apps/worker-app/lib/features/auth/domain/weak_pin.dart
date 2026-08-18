/// Client-side weak-PIN heuristic — the HARD CLIENT BLOCK on the set/reset-PIN
/// screens for the few PINs no worker should ever pick.
///
/// The server remains the real policy authority (it can reject other weak PINs
/// on `pin/set` that this narrow heuristic does not know about — see the
/// screens' failure dialogs). This local check exists so the most obvious cases
/// (1111 / 1234) are stopped IMMEDIATELY with a centred, readable explanation,
/// rather than sailing through to a late, confusing server rejection — and, on
/// the reset flow, before they waste the worker's one-time OTP.
///
/// It is deliberately NARROW to avoid a false block on a perfectly good PIN:
/// returns true only for an all-same run (1111) or a strict ascending /
/// descending sequence (1234 / 4321). Anything else passes.
bool isWeakPin(String pin) {
  if (pin.length < 2) return false;
  final List<int> digits = pin.split('').map(int.tryParse).whereType<int>().toList();
  if (digits.length != pin.length) return false; // non-digit → let server judge

  final bool allSame = digits.every((int d) => d == digits.first);
  if (allSame) return true;

  bool ascending = true;
  bool descending = true;
  for (int i = 1; i < digits.length; i++) {
    if (digits[i] != digits[i - 1] + 1) ascending = false;
    if (digits[i] != digits[i - 1] - 1) descending = false;
  }
  return ascending || descending;
}
