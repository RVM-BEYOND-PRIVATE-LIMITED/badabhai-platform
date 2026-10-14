import '../../trade_form/domain/trade_form_models.dart';

/// How far the worker got through the trade form they were handed — the ONE
/// thing the "FORM ADHOORA HAI" card on Mere resume is allowed to be about.
///
/// THE BUG THIS REPLACES (`mera_111.jpeg`). The card used to render whenever
/// `GET /workers/me/profile-summary` reported any of its nine profile-strength
/// slots empty (role, trade, skills, machines, experience, salary, location,
/// availability, photo). Those slots are read from `worker_profiles`, which
/// only the chat interview's extraction writes — the form's own answers land
/// elsewhere (`work_preferences`, the pack answers), and a profile photo or a
/// canonical trade id no form question can supply at all. So the card showed
/// for a brand-new worker who had never seen a form, and came straight back
/// after "Resume poora karein" was walked to the end: it was never measuring
/// the form it told the worker to finish.
///
/// Built from `GET /profiling/form` instead: the questions the server says
/// this worker still has to answer on the form they were actually handed.
class ResumeFormProgress {
  const ResumeFormProgress({required this.answered, required this.total});

  /// Counted from [form]'s question steps — each carries the server's saved
  /// answer, or none.
  factory ResumeFormProgress.fromForm(TradeForm form) {
    final List<TradeFormQuestionStep> questions = form.questionSteps.toList();
    return ResumeFormProgress(
      answered:
          questions.where((TradeFormQuestionStep q) => q.isAnswered).length,
      total: questions.length,
    );
  }

  final int answered;
  final int total;

  /// Questions the worker has not answered yet.
  int get left => (total - answered).clamp(0, total);

  /// True only when there IS a form and part of it is still unanswered. An
  /// empty form is not "unfinished", and a fully answered one is done.
  bool get isIncomplete => total > 0 && left > 0;

  /// 0–100, for the card's bar. Never above 100.
  int get percent => total <= 0 ? 0 : ((answered / total) * 100).round().clamp(0, 100);
}
