import '../../../core/api/api_client.dart';
import '../../../core/error/failure_mapper.dart';
import '../domain/interview_kit.dart';
import '../domain/interview_kit_repository.dart';

/// Interview-kit source.
///
/// The kit LIST and the inline Q&A CONTENT are static, curated client-side, and
/// carry no PII — and there is NO backend for them (no list route, and the
/// `/interview-kit/:tradeKey/download` route returns a PDF, not inline Q&A), so
/// [listKits]/[kit] stay hard-coded. BLOCKED on a worker confirmed-trade source
/// (to drive the list) + a Q&A endpoint; tracked as a §7 follow-up.
///
/// [downloadUrl] IS wired to the real public endpoint via [ApiClient].
class InterviewKitRepositoryImpl implements InterviewKitRepository {
  InterviewKitRepositoryImpl(this._api);

  final ApiClient _api;

  @override
  Future<List<KitListItem>> listKits() async {
    // Mock network latency so the loading state renders.
    await Future<void>.delayed(const Duration(milliseconds: 300));
    return const <KitListItem>[
      KitListItem(
        tradeKey: 'cnc_operator',
        title: 'CNC Operator',
        subtitle: '15 sawaal · jawaab ke saath',
      ),
    ];
  }

  @override
  Future<InterviewKit> kit(String tradeKey) async {
    await Future<void>.delayed(const Duration(milliseconds: 300));
    return InterviewKit(
      tradeKey: tradeKey,
      title: 'CNC Operator',
      qas: const <KitQa>[
        KitQa(
          question: 'Fanuc aur Siemens control mein kya farq hai?',
          answer:
              'Dono CNC controllers hain — Fanuc zyada common hai India mein. '
              'G-code thoda alag hota hai; main dono pe kaam kar chuka hoon.',
        ),
        KitQa(
          question: 'Tool offset kaise set karte hain?',
          answer:
              'Tool ko reference par le jaakar, offset page mein X aur Z values '
              'daalte hain; phir trial cut se verify karte hain.',
        ),
        KitQa(
          question: 'Job reject ho jaye to kya karein?',
          answer:
              'Pehle drawing aur GD&T check karte hain, phir tool wear aur '
              'program dekhte hain. Supervisor ko turant batate hain.',
        ),
      ],
    );
  }

  @override
  Future<String> downloadUrl(String tradeKey) async {
    try {
      final InterviewKitDownload dl = await _api.downloadInterviewKit(tradeKey);
      return dl.url;
    } catch (error) {
      throw mapError(error);
    }
  }
}
