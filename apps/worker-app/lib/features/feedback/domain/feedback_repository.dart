import 'feedback_category.dart';

/// Boundary for submitting the worker's app feedback to the admin console.
///
/// Implementations read the bearer token off the session (never the widget) and
/// throw a [Failure] on error.
abstract interface class FeedbackRepository {
  /// Submit [message] (the worker's own words) with an optional [category].
  Future<void> submit({required String message, FeedbackCategory? category});
}
