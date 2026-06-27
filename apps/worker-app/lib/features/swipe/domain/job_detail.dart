import 'package:equatable/equatable.dart';

/// A full job posting (spec §5.6 / `.aw-jd`). MOCK-ONLY display model for the
/// alpha — the worker-facing detail carries employer-name + pay, which are
/// PII-sensitive (CLAUDE.md §2) and need an ADR before any live endpoint serves
/// them. Synthesised client-side; never sent to a real endpoint, event, or log.
class JobDetail extends Equatable {
  const JobDetail({
    required this.jobId,
    required this.title,
    required this.company,
    this.verified = true,
    required this.location,
    required this.shift,
    required this.payBand,
    required this.duties,
    required this.requirements,
    required this.benefits,
  });

  final String jobId;
  final String title;
  final String company;
  final bool verified;
  final String location;
  final String shift;
  final String payBand;

  /// "Kaam kya hai" bullet list.
  final List<String> duties;

  /// "Chahiye" requirement tags.
  final List<String> requirements;

  /// "Faayde" bullet list.
  final List<String> benefits;

  @override
  List<Object?> get props => <Object?>[
        jobId,
        title,
        company,
        verified,
        location,
        shift,
        payBand,
        duties,
        requirements,
        benefits,
      ];
}
