import 'package:equatable/equatable.dart';

/// The REAL facts about a job, exactly as the worker-facing feed serves them
/// (`GET /feed` → `FeedItem`) — nothing is synthesised client-side.
///
/// Deliberately carries NO employer name and NO pay band: the feed does not
/// return them, because employer names are PII (CLAUDE.md §2) and no
/// worker-facing route exposes pay. An earlier build invented both from
/// `jobId.hashCode` and rendered them as fact (with a "verified" badge), so a
/// worker could apply on the strength of a salary no employer ever offered.
/// Do NOT reintroduce a field here that the backend cannot supply.
class JobDetail extends Equatable {
  const JobDetail({
    required this.jobId,
    required this.title,
    this.city,
    this.area,
    this.applicationAction,
  });

  final String jobId;

  /// Real posting title from the feed.
  final String title;

  /// Real city from the feed; null when the feed omits it.
  final String? city;

  /// Coarse area/locality bucket. Nullable — not every job has one.
  final String? area;

  /// The worker's OWN recorded decision on this job, when the opening surface
  /// knows it — the real `action` value from GET /workers/me/applications
  /// ('applied' | 'skipped'). Null when the job arrived from the feed (which,
  /// post-WA-1, only serves undecided jobs). The detail screen gates its CTA on
  /// this: an already-applied job shows its status, never an apply action.
  final String? applicationAction;

  /// True when the worker has already applied — the detail screen must render
  /// the applied status instead of the "Apply karein" CTA (WA-2).
  bool get alreadyApplied => applicationAction == 'applied';

  /// "Area, City" when both are present; otherwise whichever exists; null when
  /// neither does — the screen then renders no location line at all rather than
  /// inventing a placeholder.
  String? get place {
    final String? c = (city?.isNotEmpty ?? false) ? city : null;
    final String? a = (area?.isNotEmpty ?? false) ? area : null;
    if (a != null && c != null) return '$a, $c';
    return c ?? a;
  }

  @override
  List<Object?> get props =>
      <Object?>[jobId, title, city, area, applicationAction];
}
