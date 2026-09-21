import 'package:badabhai_worker_app/core/session/known_worker_facts_store.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_answered_facts.dart';
import 'package:flutter_test/flutter_test.dart';

WorkerFact? _fact(
  String? asked,
  String reply, {
  bool tapped = false,
  List<String> essentials = const <String>[],
}) =>
    chatAnsweredFact(
      askedQuestionId: asked,
      reply: reply,
      tappedOption: tapped,
      unansweredEssentials: essentials,
    );

void main() {
  group('chatAnsweredFact — record only what the server kept', () {
    test('preferred cities: any non-empty answer (stored verbatim)', () {
      expect(_fact('preferred_locations', 'Pune ya Nashik'),
          WorkerFact.preferredCities);
      expect(_fact('preferred_locations', '   '), isNull);
    });

    test('salary: a chip, or a typed answer with a number', () {
      expect(_fact('salary_expected', '18000'), WorkerFact.salary);
      expect(_fact('salary_expected', '20-25 hazaar', tapped: true),
          WorkerFact.salary);
      expect(_fact('salary_expected', 'jitna theek lage'), isNull,
          reason: 'the salary parser drops it, so it is not known');
    });

    test('shift: a tapped chip only (unmatched text is dropped)', () {
      expect(_fact('shift_preference', 'Din', tapped: true), WorkerFact.shift);
      expect(_fact('shift_preference', 'kabhi bhi'), isNull);
    });

    test('current city: only once it leaves unanswered_essentials', () {
      expect(_fact('current_city', 'Faridabad'), WorkerFact.currentCity);
      expect(
          _fact('current_city', 'yahin paas',
              essentials: <String>['current_city']),
          isNull);
    });

    test('any other question, or no asked id, records nothing', () {
      expect(_fact('education', '10th', tapped: true), isNull);
      expect(_fact(null, 'Pune'), isNull);
    });
  });
}
