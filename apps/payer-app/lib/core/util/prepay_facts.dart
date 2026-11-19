/// FACTS BEFORE PAYING (#2747, ADR-0064 §3.2) — the six facts a company may see before spending
/// a credit, and how they read.
///
/// The server decides whether the part is on: while `APPLICANT_FACTS_ROLLOUT` is on for the
/// company every applicant/search row carries all six keys (a `null` means "not given"); while it
/// is off it carries none. Presence of the keys is therefore the only switch the app reads.
library;

/// The one phrase a missing fact prints — never a blank.
const String kNotGiven = 'not given';

/// #2747 — the two labels a card prints for where the applicant came from.
const String kRvmStudentLabel = 'RVM student';
const String kBadaBhaiWorkerLabel = 'BadaBhai worker';

String? applicantSourceLabel(String? source) => switch (source) {
      'rvm_student' => kRvmStudentLabel,
      'badabhai_worker' => kBadaBhaiWorkerLabel,
      _ => null,
    };

/// One fact as the card prints it: a missing value is "not given", never blank.
String factText(String? value) {
  if (value == null || value.trim().isEmpty) return kNotGiven;
  return value;
}

/// The salary is printed EXACTLY as sent — never rebuilt, never trimmed into a different value.
String salaryText(String? value) => value ?? kNotGiven;

/// Machines as a readable list; none recorded reads "not given" (never an empty line).
String machinesText(List<String>? value) {
  if (value == null || value.isEmpty) return kNotGiven;
  return value.join(', ');
}

/// The six facts as (label, value) pairs, in the card's order.
List<(String, String)> prePayFactLines({
  String? firstName,
  String? tradeLine,
  String? expectedSalary,
  List<String>? machines,
  String? area,
  String? lastActiveOn,
}) =>
    <(String, String)>[
      ('Name', factText(firstName)),
      ('Trade', factText(tradeLine)),
      ('Expected salary', salaryText(expectedSalary)),
      ('Machines', machinesText(machines)),
      ('Area', factText(area)),
      ('Last active', factText(lastActiveOn)),
    ];
