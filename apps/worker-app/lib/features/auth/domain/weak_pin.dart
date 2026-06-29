/// Client-side weak-PIN heuristic — for a GENTLE hint only, never a block.
///
/// The server is the real policy authority (it can reject a weak PIN on
/// `pin/set`). This local check just lets the set-PIN screen nudge the worker
/// ("1111 / 1234 jaise PIN na chunein") before they submit, so a low-literacy
/// user is not surprised by a server rejection.
///
/// Returns true for an all-same run (1111) or a strict ascending / descending
/// sequence (1234 / 4321). Anything else passes (no hint).
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
