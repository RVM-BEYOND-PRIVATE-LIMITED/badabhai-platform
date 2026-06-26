import '../domain/interview_kit.dart';
import '../domain/interview_kit_repository.dart';

/// MOCK-ONLY interview-kit source for the alpha.
///
/// Kit content is static, curated client-side, and carries no PII — so it is
/// safe to ship hard-coded without a backend. Only the single CNC Operator
/// trade ships now; per-trade content (and the interview-day checklist) are a
/// follow-up. (A later stage moves this behind a real InterviewKitRepository.)
class InterviewKitRepositoryImpl implements InterviewKitRepository {
  const InterviewKitRepositoryImpl();

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
}
