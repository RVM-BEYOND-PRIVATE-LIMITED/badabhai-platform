import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// The SHIPPED question-pack corpus, read from the repo, and the subset the
/// trade form serves (`GET /profiling/form` — the handed-over trade pack's own
/// questions; no universal tail since #1503).
///
/// WHY READ THE FILES. The hand-kept key list this replaced ("the nine live
/// form packs", `form_fact_registry_test.dart`) went stale the day seven more
/// form trades shipped (2026-09-24/25): 68 of their keys were missing from
/// `trade_form_topics.dart` and fell into the Technical Skills walk. A list
/// copied into a test drifts silently; the corpus cannot.
///
/// WHICH PACKS ARE FORM PACKS. The source of truth is `formEnabled: true` +
/// `packId` in `apps/api/src/profiling/roles/*.role.ts`. This deliberately does
/// NOT read that server directory — a worker-app test that reads `../api/...`
/// must be listed byte-for-byte in ci.yml's `worker-app-parity` filter (TD144).
/// It uses the property every form pack carries and no other pack does: tier
/// tags (`min_tier`, `docs/profiling-tiers/tier-tagging.md` — tiers scope the
/// FORM), on the ACTIVE version (the form never serves another). The sixteen
/// known form packs are pinned as a floor ([kKnownFormPackIds]), so the
/// heuristic can never silently shrink the set.
///
/// CI. `packages/db/data/question-packs/**` is in ci.yml's `worker-app-parity`
/// filter, so a PR that changes only a pack still runs the suites that read
/// it.
///
/// Paths are relative to `apps/worker-app` — where `flutter test` runs, in CI
/// (`worker-app.yml` `working-directory`) and locally — like the other tests
/// that read a shared file (`job_card_contract_test.dart`).
const String kQuestionPackDir = '../../packages/db/data/question-packs/packs';

/// The form-enabled packs as of 2026-10-16 (role-registry.ts: 16 of 21 roles;
/// the five moulding/plastic roles are declared but disabled and have no pack
/// file). A FLOOR, not the definition — see the library doc.
const Set<String> kKnownFormPackIds = <String>{
  // Batch 1 — the nine `trade_form_topics.dart` was first written for.
  'qp_cnc_turning', 'qp_vmc_milling', 'qp_cnc_grinding',
  'qp_conventional_machining', 'qp_tool_die_making', 'qp_cam_programming',
  'qp_cad_drafting', 'qp_welding_trade', 'qp_powder_coating',
  // Batch 2 — shipped 2026-09-24/25.
  'qp_sheet_metal_fab', 'qp_press_operation', 'qp_fitter',
  'qp_maintenance_tech', 'qp_industrial_electrician', 'qp_assembly_line',
  'qp_quality_inspection',
};

/// One pack file, as shipped.
class ShippedPack {
  const ShippedPack({
    required this.packId,
    required this.version,
    required this.active,
    required this.tierTagged,
    required this.questionKeys,
  });

  final String packId;
  final int version;
  final bool active;

  /// Whether any item carries a `min_tier` — the trade form's tier tag.
  final bool tierTagged;

  /// The items' `question_key`s, in pack order.
  final List<String> questionKeys;
}

/// Every pack file under [kQuestionPackDir]. Fails loudly (never an empty
/// list) when the directory is missing — an empty corpus would pass every
/// "each key is mapped" check vacuously.
List<ShippedPack> readShippedPacks() {
  final Directory dir = Directory(kQuestionPackDir);
  if (!dir.existsSync()) {
    fail('$kQuestionPackDir not found — run `flutter test` from apps/worker-app '
        '(cwd is ${Directory.current.path}).');
  }
  final List<File> files = dir
      .listSync()
      .whereType<File>()
      .where((File f) => f.path.endsWith('.json'))
      .toList()
    ..sort((File a, File b) => a.path.compareTo(b.path));
  return <ShippedPack>[
    for (final File file in files) _parse(file),
  ];
}

ShippedPack _parse(File file) {
  final Map<String, dynamic> json =
      jsonDecode(file.readAsStringSync()) as Map<String, dynamic>;
  final List<Map<String, dynamic>> items =
      (json['items'] as List<dynamic>).cast<Map<String, dynamic>>();
  return ShippedPack(
    packId: json['pack_id'] as String,
    version: json['version'] as int,
    active: json['status'] == 'active',
    tierTagged: items.any((Map<String, dynamic> i) => i['min_tier'] != null),
    questionKeys: <String>[
      for (final Map<String, dynamic> item in items)
        item['question_key'] as String,
    ],
  );
}

/// The packs the trade form can serve: active and tier-tagged. Keyed by pack
/// id (the form never serves two versions of one pack).
Map<String, ShippedPack> readFormPacks() => <String, ShippedPack>{
      for (final ShippedPack pack in readShippedPacks())
        if (pack.active && pack.tierTagged) pack.packId: pack,
    };
