import 'package:flutter_test/flutter_test.dart';

import 'package:payer_app/core/data/job_posting_chat_models.dart';
import 'package:payer_app/core/data/models.dart';
import 'package:payer_app/features/job_posting_chat/domain/chat_message.dart';
import 'package:payer_app/features/job_posting_chat/domain/job_posting_chat_repository.dart';
import 'package:payer_app/features/job_posting_chat/presentation/bloc/job_posting_chat_bloc.dart';

/// A scripted [JobPostingChatRepository] — no HTTP, no locator.
class _FakeRepo implements JobPostingChatRepository {
  _FakeRepo({
    this.opening,
    this.openThrows = false,
    this.transcript,
    this.turns = const <JobPostingChatTurn>[],
    this.sendThrows = false,
    this.publishError,
  });

  final JobPostingChatTurn? opening;
  final bool openThrows;
  final JobPostingChatTranscript? transcript;
  final List<JobPostingChatTurn> turns;
  final bool sendThrows;
  final PayerApiException? publishError;

  String? _sessionId;
  int _turn = 0;
  int openCalls = 0;
  final List<String> sent = <String>[];

  @override
  String? get sessionId => _sessionId;

  @override
  Future<JobPostingChatTurn?> openSession() async {
    openCalls++;
    if (openThrows) throw const PayerApiException(503);
    _sessionId = 'session-1';
    return opening;
  }

  @override
  void resumeSession(String id) => _sessionId = id;

  @override
  Future<JobPostingChatTurn> sendMessage(String text) async {
    sent.add(text);
    if (sendThrows) throw const PayerApiException(500);
    final JobPostingChatTurn turn =
        turns[_turn < turns.length ? _turn : turns.length - 1];
    _turn++;
    return turn;
  }

  @override
  Future<JobPostingChatTranscript?> loadTranscript() async => transcript;

  @override
  Future<List<JobPostingChatSessionSummary>> listSessions() async =>
      const <JobPostingChatSessionSummary>[];

  @override
  Future<String> publish() async {
    final PayerApiException? err = publishError;
    if (err != null) throw err;
    return 'job-9';
  }
}

JobPostingChatTurn _turn({
  String reply = 'next?',
  JobPostingDraft? draft,
  bool ready = false,
  bool blocked = false,
  List<String> chips = const <String>[],
}) =>
    JobPostingChatTurn(
      sessionId: 'session-1',
      reply: reply,
      draft: draft,
      draftReady: ready,
      blocked: blocked,
      suggestedReplies: chips,
    );

JobPostingChatTranscript _transcript({
  List<JobPostingChatMessageRow> messages = const <JobPostingChatMessageRow>[],
  JobPostingDraft? draft,
  bool ready = false,
}) =>
    JobPostingChatTranscript(
      sessionId: 'web-session-7',
      draft: draft,
      draftReady: ready,
      messages: messages,
    );

void main() {
  group('JobPostingChatBloc — session lifecycle', () {
    test('opens with the canned line, then swaps in the SERVER opening turn',
        () async {
      final _FakeRepo repo = _FakeRepo(
        opening: _turn(reply: 'Kaunsa kaam?', chips: <String>['CNC Setter']),
      );
      final JobPostingChatBloc bloc = JobPostingChatBloc(repo);

      expect(bloc.state.messages.single.text, kJobPostingChatOpeningText);

      bloc.add(const JobPostingChatStarted());
      await bloc.stream.firstWhere((JobPostingChatState s) => !s.initializing);

      expect(bloc.state.messages.first.text, 'Kaunsa kaam?');
      expect(bloc.state.messages.length, 1,
          reason: 'the opener REPLACES bubble 0 — never a second greeting');
      expect(bloc.state.followups, <String>['CNC Setter']);
      await bloc.close();
    });

    test('a failed open SURFACES a banner instead of a silent dead session',
        () async {
      final _FakeRepo repo = _FakeRepo(openThrows: true);
      final JobPostingChatBloc bloc = JobPostingChatBloc(repo);

      bloc.add(const JobPostingChatStarted());
      await bloc.stream.firstWhere((JobPostingChatState s) => !s.initializing);

      expect(bloc.state.sessionFailed, isTrue);
      expect(bloc.state.messages.single.text, kJobPostingChatOpeningText);
      await bloc.close();
    });

    test('CROSS-DEVICE resume binds the given session, hydrates the transcript '
        'AND the draft — no new session is opened', () async {
      // The web-started conversation, picked up on the phone. The draft must
      // come back with it: making the payer re-answer to see what they already
      // built is the failure this endpoint exists to prevent.
      final _FakeRepo repo = _FakeRepo(
        transcript: _transcript(
          messages: const <JobPostingChatMessageRow>[
            JobPostingChatMessageRow(
                fromPayer: false, bodyText: 'Kaunsa kaam?'),
            JobPostingChatMessageRow(fromPayer: true, bodyText: 'CNC Setter'),
          ],
          draft: const JobPostingDraft(
            roleTitle: 'CNC Setter',
            vacancyBand: '2-5',
          ),
          ready: true,
        ),
      );
      final JobPostingChatBloc bloc = JobPostingChatBloc(repo);

      bloc.add(const JobPostingChatStarted(resumeSessionId: 'web-session-7'));
      await bloc.stream
          .firstWhere((JobPostingChatState s) => s.messages.length > 1);

      expect(repo.openCalls, 0, reason: 'resuming must not open a new session');
      expect(repo.sessionId, 'web-session-7');
      expect(
        bloc.state.messages.map((ChatMessage m) => m.text),
        <String>['Kaunsa kaam?', 'CNC Setter'],
        reason: 'the stored transcript replaces the canned greeting',
      );
      expect(bloc.state.draft.roleTitle, 'CNC Setter');
      expect(bloc.state.draft.vacancyBand, '2-5');
      expect(bloc.state.draftReady, isTrue);
      await bloc.close();
    });
  });

  group('JobPostingChatBloc — turns', () {
    test('a send appends both bubbles and carries the server draft + chips',
        () async {
      final _FakeRepo repo = _FakeRepo(turns: <JobPostingChatTurn>[
        _turn(
          reply: 'Kitne log?',
          chips: <String>['1', '2-5'],
          draft: const JobPostingDraft(roleTitle: 'CNC Setter'),
        ),
      ]);
      final JobPostingChatBloc bloc = JobPostingChatBloc(repo);
      bloc.add(const JobPostingChatStarted());
      await bloc.stream.firstWhere((JobPostingChatState s) => !s.initializing);

      bloc.add(const JobPostingChatMessageSent('CNC Setter chahiye'));
      await bloc.stream.firstWhere((JobPostingChatState s) => !s.sending);

      expect(bloc.state.messages.map((ChatMessage m) => m.text).toList(),
          <String>[kJobPostingChatOpeningText, 'CNC Setter chahiye', 'Kitne log?']);
      expect(bloc.state.followups, <String>['1', '2-5']);
      expect(bloc.state.draft.roleTitle, 'CNC Setter');
      await bloc.close();
    });

    test('a BLOCKED turn keeps the draft it already had and flags the notice',
        () async {
      final _FakeRepo repo = _FakeRepo(turns: <JobPostingChatTurn>[
        _turn(draft: const JobPostingDraft(roleTitle: 'CNC Setter')),
        // The fail-closed fallback: no draft, no chips.
        _turn(reply: 'Dobara likhiye', blocked: true),
      ]);
      final JobPostingChatBloc bloc = JobPostingChatBloc(repo);
      bloc.add(const JobPostingChatStarted());
      await bloc.stream.firstWhere((JobPostingChatState s) => !s.initializing);

      bloc.add(const JobPostingChatMessageSent('CNC Setter'));
      await bloc.stream.firstWhere((JobPostingChatState s) => !s.sending);
      bloc.add(const JobPostingChatMessageSent('my number is …'));
      await bloc.stream.firstWhere(
          (JobPostingChatState s) => !s.sending && s.lastReplyBlocked);

      expect(bloc.state.lastReplyBlocked, isTrue);
      expect(bloc.state.draft.roleTitle, 'CNC Setter',
          reason: 'a blocked turn must never blank a field already captured');
      await bloc.close();
    });

    test('a failed send marks the bubble FAILED and invents no reply',
        () async {
      final _FakeRepo failing = _FakeRepo(sendThrows: true);
      final JobPostingChatBloc bloc = JobPostingChatBloc(failing);
      bloc.add(const JobPostingChatStarted());
      await bloc.stream.firstWhere((JobPostingChatState s) => !s.initializing);

      bloc.add(const JobPostingChatMessageSent('CNC Setter'));
      await bloc.stream.firstWhere((JobPostingChatState s) => !s.sending);

      expect(bloc.state.messages.last.status, ChatSendStatus.failed);
      expect(bloc.state.messages.length, 2,
          reason: 'no assistant bubble is invented for a send that never landed');
      await bloc.close();
    });

    test('draftReady LATCHES — a later turn cannot un-ready the publish action',
        () async {
      final _FakeRepo repo = _FakeRepo(turns: <JobPostingChatTurn>[
        _turn(ready: true, draft: const JobPostingDraft(roleTitle: 'X')),
        _turn(ready: false),
      ]);
      final JobPostingChatBloc bloc = JobPostingChatBloc(repo);
      bloc.add(const JobPostingChatStarted());
      await bloc.stream.firstWhere((JobPostingChatState s) => !s.initializing);

      bloc.add(const JobPostingChatMessageSent('a'));
      await bloc.stream.firstWhere((JobPostingChatState s) => s.draftReady);
      bloc.add(const JobPostingChatMessageSent('b'));
      await bloc.stream.firstWhere(
          (JobPostingChatState s) => s.messages.length >= 5 && !s.sending);

      expect(bloc.state.draftReady, isTrue);
      await bloc.close();
    });
  });

  group('JobPostingChatBloc — publish', () {
    test('success reports the created posting id', () async {
      final JobPostingChatBloc bloc = JobPostingChatBloc(_FakeRepo());
      bloc.add(const JobPostingChatPublishRequested());
      await bloc.stream.firstWhere(
          (JobPostingChatState s) => s.publishOutcome != PublishOutcome.none);

      expect(bloc.state.publishOutcome, PublishOutcome.success);
      expect(bloc.state.publishedJobId, 'job-9');
      await bloc.close();
    });

    test('400 → incomplete, 409 → conflict, 500 → failed (each honest)',
        () async {
      const Map<int, PublishOutcome> expected = <int, PublishOutcome>{
        400: PublishOutcome.incomplete,
        409: PublishOutcome.conflict,
        500: PublishOutcome.failed,
      };
      for (final MapEntry<int, PublishOutcome> e in expected.entries) {
        final JobPostingChatBloc bloc = JobPostingChatBloc(
          _FakeRepo(publishError: PayerApiException(e.key)),
        );
        bloc.add(const JobPostingChatPublishRequested());
        await bloc.stream.firstWhere(
            (JobPostingChatState s) => s.publishOutcome != PublishOutcome.none);
        expect(bloc.state.publishOutcome, e.value, reason: '${e.key}');
        await bloc.close();
      }
    });
  });
}
