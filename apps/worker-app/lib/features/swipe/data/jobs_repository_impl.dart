import '../domain/job_detail.dart';
import '../domain/jobs_repository.dart';

/// MOCK-ONLY job-detail source for the alpha.
///
/// Synthesises a full posting client-side from [jobId] so the detail screen is
/// walkable without a backend. The fabricated employer name + pay are PII-
/// sensitive on a LIVE endpoint (CLAUDE.md §2) and need an ADR ruling first;
/// these values are never sent to a real endpoint, event, ai_jobs, or a log.
/// (Stage 8 moves this into the MockApiClient behind a real JobsRepository.)
class JobsRepositoryImpl implements JobsRepository {
  const JobsRepositoryImpl();

  @override
  Future<JobDetail> jobDetail(String jobId) async {
    // Mock network latency so the loading state renders.
    await Future<void>.delayed(const Duration(milliseconds: 300));

    const List<String> companies = <String>[
      'Sharma Precision Works',
      'Deccan Auto Components',
      'Kalyani Industries',
      'MIDC Engineering Co.',
    ];
    const List<String> bands = <String>[
      '18,000–24,000/mo',
      '22,000–28,000/mo',
      '25,000–32,000/mo',
      '28,000–36,000/mo',
    ];
    final int seed = jobId.hashCode & 0x7fffffff;

    return JobDetail(
      jobId: jobId,
      title: 'CNC Operator',
      company: companies[seed % companies.length],
      location: 'Pimpri, Pune',
      shift: seed.isEven ? 'Day shift' : 'Rotational',
      payBand: bands[seed % bands.length],
      duties: const <String>[
        'Fanuc CNC machine operate karna',
        'Program load + quality check',
        'Output target maintain karna',
      ],
      requirements: const <String>['Fanuc control', '2+ yrs', 'ITI / diploma'],
      benefits: const <String>[
        'PF + ESI + overtime',
        'Canteen + transport',
      ],
    );
  }
}
