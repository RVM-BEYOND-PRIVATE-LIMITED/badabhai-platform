import 'package:equatable/equatable.dart';

import '../../../core/api/api_models.dart' show MatchSkillDto;
import '../../../core/util/taxonomy_labels.dart';

/// One kind of work the worker holds, and whether he still wants to be shown
/// to employers for it (E4, #1828). Server truth — never set optimistically.
class MatchSkill extends Equatable {
  const MatchSkill({
    required this.skillId,
    required this.label,
    required this.wants,
  });

  /// Closed-vocabulary id (`mskill_*`). Sent back on a write, NEVER rendered.
  final String skillId;

  /// What the switch reads. The server's checked-in label; when a row arrives
  /// without one (or with the bare id as its label) it is humanized here, at
  /// the display edge, so no raw id ever reaches the screen.
  final String label;

  final bool wants;

  factory MatchSkill.fromDto(MatchSkillDto dto) {
    final String raw = dto.label.trim();
    return MatchSkill(
      skillId: dto.skillId,
      label: raw.isEmpty || raw == dto.skillId
          ? taxonomyLabel(dto.skillId)
          : raw,
      wants: dto.wants,
    );
  }

  MatchSkill withWants(bool value) =>
      MatchSkill(skillId: skillId, label: label, wants: value);

  @override
  List<Object?> get props => <Object?>[skillId, label, wants];
}
