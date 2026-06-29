/// Configuration for the lifecycle re-lock (PASS 2 §5).
///
/// FLAG: [relockAfter] is the single tunable for "how long backgrounded before
/// we ask the PIN again". Five minutes balances security (a borrowed / lost
/// phone re-locks quickly) against friction (a worker glancing at WhatsApp and
/// coming straight back is NOT re-prompted). Lower it for a higher-security
/// build; raise it for fewer prompts. Cold start always re-locks regardless of
/// this window (it goes through `bootstrap()`).
class RelockConfig {
  RelockConfig._();

  /// Background duration after which `resumed` re-locks to the PIN screen.
  static const Duration relockAfter = Duration(minutes: 5);
}
