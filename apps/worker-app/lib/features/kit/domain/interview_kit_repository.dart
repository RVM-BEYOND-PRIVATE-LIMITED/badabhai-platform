import 'interview_kit.dart';

/// Interview-kit boundary. Lists the kits available to the worker and loads a
/// single per-trade kit. Implementations throw a [Failure] on error.
abstract interface class InterviewKitRepository {
  Future<List<KitListItem>> listKits();
  Future<InterviewKit> kit(String tradeKey);
}
