/// The coarse, fixed tags a worker can put on app feedback.
///
/// [wire] is the snake token the admin console groups by; [label] is the
/// worker-facing Hinglish. Tagging is OPTIONAL — the worker is never forced to
/// pick one, so a category can be null all the way to the wire.
enum FeedbackCategory {
  suggestion('suggestion', 'Sujhaav'),
  problem('problem', 'Dikkat'),
  other('other', 'Kuch aur');

  const FeedbackCategory(this.wire, this.label);

  /// The stable token sent to the API (never the localized [label]).
  final String wire;

  /// The worker-facing chip text.
  final String label;
}
