import 'feedback_category.dart';

/// Boundary for submitting the worker's app feedback to the admin console.
///
/// Implementations read the bearer token off the session (never the widget) and
/// throw a [Failure] on error.
abstract interface class FeedbackRepository {
  /// Submit [message] (the worker's own words) with an optional [category].
  ///
  /// [screen] is the RAW route the worker was on when they opened Feedback. It is
  /// passed raw ON PURPOSE: the implementation normalizes it into a route pattern
  /// (dropping ids, query and fragment) at the wire boundary, so no caller can
  /// forget to and no caller has to know the contract. A value that cannot be
  /// normalized is simply not sent — it must never cost the worker their message.
  Future<void> submit({
    required String message,
    FeedbackCategory? category,
    String? screen,
  });
}
