import '../../../core/api/api_models.dart' show QualificationOptionsDto;
import '../../../core/util/education_label.dart';
import '../../trade_form/domain/trade_form_models.dart';

/// One row on the Resume tab's "Education & Certificates" card.
///
/// [title] is the bold line ("ITI — Electric", "CNC Turning & Fanuc
/// Programming"), [detail] the muted line under it ("NCVT · Govt Institute",
/// the issuer), and [year] the right-hand year — or null when none was given.
class ResumeQualificationItem {
  const ResumeQualificationItem({
    required this.title,
    this.detail,
    this.year,
  });

  final String title;
  final String? detail;
  final int? year;
}

/// The worker's education entries as the card shows them, NEWEST FIRST.
///
/// WHY NOT THE SHEET'S OWN LINE. The résumé document carries education as ONE
/// fact row, `Education: 10th pass · State board · 2010 · Govt School · 12th
/// pass · …`, with the entries AND each entry's parts joined by the same
/// ` · ` — so it cannot be split back into entries, and it read as a paragraph.
/// These rows come from `GET /workers/me/qualifications`, the same records the
/// sheet is rendered from, one field each.
///
/// Every slug is shown through the server's own vocabulary ([options]); a slug
/// the vocabulary does not carry is humanised, never printed raw.
List<ResumeQualificationItem> resumeEducationItems(
  List<TradeFormEducationEntry> educations, {
  QualificationOptionsDto? options,
}) {
  final List<ResumeQualificationItem> items = <ResumeQualificationItem>[];
  for (final TradeFormEducationEntry e in educations) {
    final String? credential = _label(e.credential, options?.educationCredential);
    final String? field = _clean(e.field);
    final String? council = _label(e.council, options?.educationCouncil);
    final String? institute = _clean(e.institute);
    final String title = <String>[
      ?credential,
      ?field,
    ].join(' — ');
    final String detail = <String>[?council, ?institute].join(' · ');
    if (title.isEmpty && detail.isEmpty && e.year == null) continue;
    items.add(
      ResumeQualificationItem(
        // A row with no credential and no field still has SOMETHING to say;
        // its board or institute moves up rather than leaving a blank title.
        title: title.isNotEmpty ? title : detail,
        detail: title.isNotEmpty && detail.isNotEmpty ? detail : null,
        year: e.year,
      ),
    );
  }
  return sortNewestFirst(items);
}

/// The worker's certificates as the card shows them, NEWEST FIRST: the name,
/// the issuer under it, the year on the right.
List<ResumeQualificationItem> resumeCertificateItems(
  List<TradeFormCertificateEntry> certificates,
) {
  final List<ResumeQualificationItem> items = <ResumeQualificationItem>[
    for (final TradeFormCertificateEntry c in certificates)
      if (_clean(c.name) != null)
        ResumeQualificationItem(
          title: _clean(c.name)!,
          detail: _clean(c.issuer),
          year: c.year,
        ),
  ];
  return sortNewestFirst(items);
}

/// NEWEST YEAR FIRST — the order a résumé reads in, and the order the Work
/// History card above already uses. A row with no year goes LAST (there is
/// nothing to place it by), and rows with the same year keep the worker's own
/// order, so the sort never shuffles what it cannot compare.
List<ResumeQualificationItem> sortNewestFirst(
  List<ResumeQualificationItem> items,
) {
  final List<(int, ResumeQualificationItem)> indexed =
      <(int, ResumeQualificationItem)>[
        for (int i = 0; i < items.length; i++) (i, items[i]),
      ];
  indexed.sort(((int, ResumeQualificationItem) a,
      (int, ResumeQualificationItem) b) {
    final int? ya = a.$2.year;
    final int? yb = b.$2.year;
    if (ya != null && yb != null && ya != yb) return yb.compareTo(ya);
    if (ya == null && yb != null) return 1;
    if (ya != null && yb == null) return -1;
    return a.$1.compareTo(b.$1);
  });
  return <ResumeQualificationItem>[
    for (final (int, ResumeQualificationItem) e in indexed) e.$2,
  ];
}

String? _clean(String? value) {
  final String? t = value?.trim();
  return (t == null || t.isEmpty) ? null : t;
}

/// A vocabulary slug as the worker reads it: the server's label when it has
/// one, else the slug humanised — never the raw slug.
String? _label(String? slug, Map<String, String>? vocabulary) {
  final String? s = _clean(slug);
  if (s == null) return null;
  final String? served = _clean(vocabulary?[s]);
  return served ?? humanizeEducationLevel(s);
}
