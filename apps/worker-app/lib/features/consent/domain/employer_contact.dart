import '../../../core/api/api_models.dart' show ConsentStateDto;

/// The two purposes the stop-employer-contact switch governs (E0 C-2).
///
/// ONE switch, not two: the backend removes BOTH together, because a worker who
/// is disclosable but unmessageable would sell a payer a credit for a handle
/// that dials nothing. The switch therefore reads ON only when BOTH are present.
const List<String> kEmployerContactPurposes = <String>[
  'employer_sharing',
  'employer_messaging',
];

/// The employer-contact state the switch renders, derived from the latest
/// consent row (GET /consent/me). Never optimistic local state.
class EmployerContactInfo {
  const EmployerContactInfo({required this.enabled, required this.purposes});

  /// True only when the latest row grants BOTH [kEmployerContactPurposes].
  final bool enabled;

  /// The latest row's purposes verbatim (for diagnostics; not rendered).
  final List<String> purposes;

  factory EmployerContactInfo.fromDto(ConsentStateDto dto) =>
      EmployerContactInfo(
        enabled: kEmployerContactPurposes.every(dto.purposes.contains),
        purposes: List<String>.unmodifiable(dto.purposes),
      );
}
