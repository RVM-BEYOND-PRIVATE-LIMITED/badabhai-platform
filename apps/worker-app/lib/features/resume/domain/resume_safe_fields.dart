import 'package:equatable/equatable.dart';

/// The small set of resume fields the worker is allowed to change directly
/// (spec §5.2 / `.aw-field`). Everything else on the resume is owned by the
/// extraction pipeline ("bada bhai sambhalta hai") and is not editable here.
class ResumeSafeFields extends Equatable {
  const ResumeSafeFields({
    required this.displayName,
    required this.showPhoto,
    required this.nightShiftReady,
  });

  /// The name spelling shown on the resume (worker-correctable typos only).
  final String displayName;
  final bool showPhoto;
  final bool nightShiftReady;

  ResumeSafeFields copyWith({
    String? displayName,
    bool? showPhoto,
    bool? nightShiftReady,
  }) {
    return ResumeSafeFields(
      displayName: displayName ?? this.displayName,
      showPhoto: showPhoto ?? this.showPhoto,
      nightShiftReady: nightShiftReady ?? this.nightShiftReady,
    );
  }

  @override
  List<Object?> get props =>
      <Object?>[displayName, showPhoto, nightShiftReady];
}
