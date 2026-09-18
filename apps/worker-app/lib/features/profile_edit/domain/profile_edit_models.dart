import 'package:equatable/equatable.dart';

// Re-exported so a profile-edit consumer gets the availability draft from the
// same import as the rest of this feature's models.
export '../../finishing/domain/finishing_models.dart' show AvailabilityDraft;

/// The closed `role_*` id set a worker may name as a SECONDARY occupation
/// (ADR-0042 D9 / Layer A (f), migration 0114).
///
/// Mirrors `ROLES` in `packages/taxonomy/src/index.ts` — the SAME 13 ids the
/// backend's `worker-occupations.dto.ts` derives its `z.enum` from. There is no
/// server endpoint that serves this list (the GET returns only the worker's own
/// saved rows, labelled), so the picker carries the id set and resolves labels
/// through [taxonomyLabel]. Adding a role server-side without updating this list
/// only means the new id cannot be PICKED here; a saved one still renders.
///
/// ORDER IS THE TAXONOMY'S OWN (append-only there) so the chips read in the same
/// order the workstation taxonomy does.
const List<String> kSecondaryRoleIds = <String>[
  'role_cnc_turner_operator',
  'role_vmc_operator',
  'role_hmc_operator',
  'role_cnc_setter_operator',
  'role_cnc_programmer',
  'role_cam_programmer',
  'role_cnc_grinding_operator',
  'role_welder',
  'role_cnc_operator',
  'role_plumber',
  'role_carpenter',
  'role_designer',
  'role_interior_designer',
];

/// Server cap `OCCUPATIONS_MAX` (`worker-occupations.dto.ts`).
const int kMaxSecondaryOccupations = 4;

/// Server cap `LANGUAGES_MAX`.
const int kMaxLanguages = 16;

/// Server cap `PORTFOLIO_ITEMS_MAX`.
const int kMaxPortfolioItems = 12;

/// Server cap `TRAININGS_MAX` (`worker-qualifications.dto.ts`, Layer A (d)).
const int kMaxTrainings = 8;

/// Server cap `CERTIFICATES_MAX`.
const int kMaxCertificates = 8;

/// Server cap `EDUCATIONS_MAX`.
const int kMaxEducations = 4;

/// The closed availability statuses (Layer A (c)), mirroring
/// `AVAILABILITY_STATUSES` in `worker-preferences.vocabulary.ts`.
const Map<String, String> kAvailabilityStatuses = <String, String>{
  'immediate': 'Turant',
  'within_week': '1 hafte mein',
  'within_month': '1 mahine mein',
  'notice_period': 'Notice period ke baad',
};

/// The closed salary periods (Layer A (c)). `month` is the implicit default for
/// every worker who never answers, so the picker starts there.
const Map<String, String> kSalaryPeriods = <String, String>{
  'month': 'Mahina',
  'day': 'Din',
  'year': 'Saal',
};

/// One piece of media the worker picked locally and the screen is about to
/// upload through the portfolio mint → signed-PUT → register dance.
///
/// [kind] is `photo` | `video`; [contentType] is what the mint declares and the
/// PUT sends (the server re-verifies the bucket object later). Bytes are held
/// in memory only for the duration of the upload — never persisted.
class PickedPortfolioMedia extends Equatable {
  const PickedPortfolioMedia({
    required this.kind,
    required this.contentType,
    required this.bytes,
    required this.sizeBytes,
  });

  final String kind;
  final String contentType;
  final List<int> bytes;
  final int sizeBytes;

  @override
  List<Object?> get props => <Object?>[kind, contentType, sizeBytes];
}
