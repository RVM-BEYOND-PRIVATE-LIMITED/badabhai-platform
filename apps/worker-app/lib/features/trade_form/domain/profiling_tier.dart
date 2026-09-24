import 'package:equatable/equatable.dart';

/// How long the worker is willing to spend on profiling (#1698).
///
/// The three tiers are the SERVER's closed set (`PROFILING_TIERS` in
/// `packages/types`, pinned here by `profiling_tier_contract_test.dart`). The
/// form then asks only that tier's questions, and the resume prints only that
/// tier's rows.
///
/// There is deliberately NO `unknown` member, unlike the app's other wire
/// enums. A tier this build has never heard of cannot be drawn as a card —
/// there is no title, no time estimate and no honest label for it — so an
/// unrecognised value parses to `null` and the entry is DROPPED from the list
/// rather than rendered as a mystery the worker is asked to choose.
enum ProfilingTier { easy, medium, hard }

/// The wire token for [tier] — what `POST /profiling/form/tier` takes.
String profilingTierWire(ProfilingTier tier) => switch (tier) {
      ProfilingTier.easy => 'easy',
      ProfilingTier.medium => 'medium',
      ProfilingTier.hard => 'hard',
    };

/// Null for absent, malformed, or a tier this build does not know — never
/// guessed at, and never defaulted to a real tier: defaulting would silently
/// commit the worker to an amount of work they did not choose.
ProfilingTier? profilingTierFrom(Object? raw) => switch (raw) {
      'easy' => ProfilingTier.easy,
      'medium' => ProfilingTier.medium,
      'hard' => ProfilingTier.hard,
      _ => null,
    };

/// What one tier costs this worker, for this role.
///
/// The minutes are PER ROLE and come from the server on every read. They are
/// never hard-coded in the app: a sheet-metal worker's "Medium" is not a CNC
/// turner's, and a stale constant here would be a promise the form cannot keep.
class TierEstimate extends Equatable {
  const TierEstimate({
    required this.tier,
    required this.minMinutes,
    required this.maxMinutes,
    this.questionCount = 0,
  });

  final ProfilingTier tier;
  final int minMinutes;
  final int maxMinutes;

  /// The asks the estimate was computed from. Not displayed — the worker is
  /// told the time, which is what they actually care about.
  final int questionCount;

  /// Null when the row names a tier this build does not know (see
  /// [ProfilingTier]) or carries no usable minutes.
  static TierEstimate? fromJson(Object? raw) {
    if (raw is! Map<String, dynamic>) return null;
    final ProfilingTier? tier = profilingTierFrom(raw['tier']);
    if (tier == null) return null;
    final int min = (raw['min_minutes'] as num?)?.toInt() ?? 0;
    final int max = (raw['max_minutes'] as num?)?.toInt() ?? 0;
    if (min <= 0 || max <= 0) return null;
    return TierEstimate(
      tier: tier,
      minMinutes: min,
      maxMinutes: max,
      questionCount: (raw['question_count'] as num?)?.toInt() ?? 0,
    );
  }

  @override
  List<Object?> get props => <Object?>[
        tier,
        minMinutes,
        maxMinutes,
        questionCount,
      ];
}

/// `GET /profiling/form/tiers` — may this worker choose, and what are the
/// choices?
///
/// [disabled] is the answer to THREE different server states that all mean the
/// same thing to the app: the flag is off, the pack has not been re-seeded, or
/// this worker was never handed a form (a 404). In every one of them the app
/// opens the full form exactly as it does today.
class TierState extends Equatable {
  const TierState({
    this.enabled = false,
    this.kind,
    this.needsChoice = false,
    this.currentTier,
    this.upgradableTo = const <ProfilingTier>[],
    this.tiers = const <TierEstimate>[],
  });

  /// `PROFILING_TIERS_ENABLED`, as the server reports it for THIS worker's
  /// pack. False ⇒ every other field is meaningless and no tier UI may show.
  final bool enabled;

  /// The trade-form kind the tiers were computed for. Carried, not displayed.
  final String? kind;

  /// Show the tier screen before the first form question.
  final bool needsChoice;

  /// The tier the form asks at; null only while [needsChoice] is true.
  final ProfilingTier? currentTier;

  /// Tiers ABOVE the current one — what "Add more detail" may offer. Empty at
  /// Hard. A downgrade is a 409 server-side and is never offered here.
  final List<ProfilingTier> upgradableTo;

  /// Easy, Medium, Hard in that order, as the server sent them.
  final List<TierEstimate> tiers;

  /// The state every failure and every older server resolves to.
  static const TierState disabled = TierState();

  /// Whether the tier SCREEN should be shown before the form opens. Fails
  /// closed on both counts: a disabled server never shows it, and neither does
  /// an enabled one that sent no usable cards to draw.
  bool get shouldChooseTier => enabled && needsChoice && tiers.isNotEmpty;

  /// Whether "Add more detail" should be offered at all.
  bool get canUpgrade => enabled && upgradableTo.isNotEmpty;

  /// The cards an upgrade may offer: the tiers in [upgradableTo], in the
  /// server's own order, and only those it also sent an estimate for.
  List<TierEstimate> get upgradeOptions => tiers
      .where((TierEstimate e) => upgradableTo.contains(e.tier))
      .toList(growable: false);

  static TierState fromJson(Object? raw) {
    if (raw is! Map<String, dynamic>) return disabled;
    final bool enabled = raw['enabled'] as bool? ?? false;
    if (!enabled) return disabled;
    return TierState(
      enabled: true,
      kind: raw['kind'] as String?,
      needsChoice: raw['needs_choice'] as bool? ?? false,
      currentTier: profilingTierFrom(raw['current_tier']),
      upgradableTo: (raw['upgradable_to'] as List<dynamic>? ?? <dynamic>[])
          .map(profilingTierFrom)
          .whereType<ProfilingTier>()
          .toList(growable: false),
      tiers: (raw['tiers'] as List<dynamic>? ?? <dynamic>[])
          .map(TierEstimate.fromJson)
          .whereType<TierEstimate>()
          .toList(growable: false),
    );
  }

  @override
  List<Object?> get props => <Object?>[
        enabled,
        kind,
        needsChoice,
        currentTier,
        upgradableTo,
        tiers,
      ];
}

/// What the server did with a tap (`POST /profiling/form/tier`).
enum TierChange {
  /// The first choice.
  selected,

  /// Raised — the caller must open the form with `view=upgrade` so the worker
  /// is asked ONLY what they have not answered yet.
  upgraded,

  /// The same tier again (a retried tap). Nothing changed server-side.
  unchanged,
}

/// The result of one tap.
class TierChoice extends Equatable {
  const TierChoice({
    required this.tier,
    this.previousTier,
    this.change = TierChange.unchanged,
  });

  final ProfilingTier tier;
  final ProfilingTier? previousTier;
  final TierChange change;

  /// Only an upgrade needs the narrowed form view; a first selection opens the
  /// ordinary full form for the tier just chosen.
  bool get needsUpgradeView => change == TierChange.upgraded;

  /// Null when the body is unusable — the caller then treats the tap as
  /// "the server did not confirm a tier" rather than inventing one.
  static TierChoice? fromJson(Object? raw) {
    if (raw is! Map<String, dynamic>) return null;
    final ProfilingTier? tier = profilingTierFrom(raw['tier']);
    if (tier == null) return null;
    return TierChoice(
      tier: tier,
      previousTier: profilingTierFrom(raw['previous_tier']),
      // An unrecognised `change` reads as `unchanged`: the safe arm, because
      // it opens the ordinary full form rather than an upgrade view that could
      // legitimately be empty.
      change: switch (raw['change']) {
        'selected' => TierChange.selected,
        'upgraded' => TierChange.upgraded,
        _ => TierChange.unchanged,
      },
    );
  }

  @override
  List<Object?> get props => <Object?>[tier, previousTier, change];
}
