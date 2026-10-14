import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart'
    show ChatOption, ChatQuestionKind, ResumeHistory, ResumeHistoryItem;
import 'package:badabhai_worker_app/core/observability/analytics.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_message.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_repository.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_resume_download.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_turn.dart';
import 'package:badabhai_worker_app/features/chat/presentation/bloc/chat_bloc.dart';
import 'package:badabhai_worker_app/features/resume/domain/resume_repository.dart';

class MockChatRepository extends Mock implements ChatRepository {}

class MockResumeRepository extends Mock implements ResumeRepository {}

const String _resumeId = '22222222-2222-4222-8222-222222222222';
const String _recap = 'Namaste. Aapki profile taiyaar hai.';
const String _ask = 'mujhe mera resume download karna hai';

ResumeHistory _history({String? renderStatus = 'rendered', bool current = true}) =>
    ResumeHistory(
      items: <ResumeHistoryItem>[
        ResumeHistoryItem(
          resumeId: _resumeId,
          renderStatus: renderStatus,
          isCurrent: current,
        ),
      ],
    );

ChatTurn _companion(String reply) => ChatTurn(
  reply: reply,
  followups: const <String>['Sabhi jobs dekhein'],
  suggestedOptions: const <ChatOption>[
    ChatOption(optionKey: 'companion_jobs_tab', labelText: 'Sabhi jobs dekhein'),
  ],
  questionKind: ChatQuestionKind.disambiguate,
  companion: true,
  digestKey: 'k1',
);

/// Owner ask (2026-10-14) — the Bada Bhai tab's "Resume download" tile: shown
/// when the tab opens, put away when the conversation moves on, shown again
/// when the worker asks for their résumé — and that ask is never posted.
void main() {
  group('isResumeDownloadRequest', () {
    for (final String ask in <String>[
      _ask,
      'Resume Download',
      'download',
      'resume ka PDF chahiye',
      'mera resume downlod kar do',
      'resume dawnload karna h',
      'cv download?',
      'रिज़्यूमे डाउनलोड करना है',
    ]) {
      test('"$ask" is a download request', () {
        expect(isResumeDownloadRequest(ask), isTrue);
      });
    }

    for (final String other in <String>[
      '',
      '   ',
      'naye jobs dikhao',
      'Resume badlein',
      'resume update karna hai',
      'mera resume chahiye',
      'naya resume banana hai',
      'downloader',
    ]) {
      test('"$other" is NOT a download request', () {
        expect(isResumeDownloadRequest(other), isFalse);
      });
    }
  });

  group('downloadableResumeIdIn', () {
    test('the CURRENT row, rendered or still rendering', () {
      expect(downloadableResumeIdIn(_history()), _resumeId);
      expect(downloadableResumeIdIn(_history(renderStatus: 'pending')), _resumeId);
      expect(downloadableResumeIdIn(_history(renderStatus: null)), _resumeId);
    });

    test('nothing for no history, no current row, or a FAILED render', () {
      expect(downloadableResumeIdIn(ResumeHistory.empty), isNull);
      expect(downloadableResumeIdIn(_history(current: false)), isNull);
      expect(downloadableResumeIdIn(_history(renderStatus: 'failed')), isNull);
    });
  });

  group('ChatBloc — the tile', () {
    late MockChatRepository repo;
    late MockResumeRepository resumes;
    late List<BbAnalyticsEvent> events;
    late DateTime now;

    setUp(() {
      repo = MockChatRepository();
      resumes = MockResumeRepository();
      events = <BbAnalyticsEvent>[];
      now = DateTime(2026, 10, 14, 12);
      when(() => repo.loadHistory()).thenAnswer((_) async => const <ChatMessage>[]);
      when(() => repo.ensureSession()).thenAnswer((_) async => null);
      when(
        () => repo.openCompanion(),
      ).thenAnswer((_) async => CompanionOpening(CompanionOpenOutcome.companion, _companion(_recap)));
      when(
        () => repo.sendCompanionMessage(any(), submissionId: any(named: 'submissionId')),
      ).thenAnswer((_) async => _companion('Kisi job par dabakar poori jaankari dekhein.'));
      when(
        () => repo.sendMessage(
          any(),
          submissionId: any(named: 'submissionId'),
          answerSource: any(named: 'answerSource'),
        ),
      ).thenAnswer((_) async => const ChatTurn(reply: 'Aage batayein.'));
      when(() => resumes.loadResumeHistory()).thenAnswer((_) async => _history());
    });

    ChatBloc build({bool withResumes = true}) => ChatBloc(
      repo,
      analyticsSink: events.add,
      clock: () => now,
      resumeRepository: withResumes ? resumes : null,
    );

    Future<ChatBloc> openTab({bool withResumes = true}) async {
      final ChatBloc bloc = build(withResumes: withResumes)
        ..add(const ChatCompanionStarted())
        ..add(const ChatResumeDownloadOffered());
      await pumpEventQueue();
      return bloc;
    }

    Iterable<String> eventNames() => events.map((BbAnalyticsEvent e) => e.name);

    test('the tab opening offers the tile for the current résumé', () async {
      final ChatBloc bloc = await openTab();

      expect(bloc.state.resumeDownloadTile, isTrue);
      expect(bloc.state.downloadableResumeId, _resumeId);
      final BbAnalyticsEvent offered = events.singleWhere(
        (BbAnalyticsEvent e) => e.name == 'chat_resume_download_offered',
      );
      expect(offered.parameters, <String, Object>{'trigger': 'open'});
      await bloc.close();
    });

    test('no résumé to download: no tile', () async {
      when(() => resumes.loadResumeHistory()).thenAnswer((_) async => ResumeHistory.empty);
      final ChatBloc bloc = await openTab();

      expect(bloc.state.resumeDownloadTile, isFalse);
      expect(bloc.state.downloadableResumeId, isNull);
      expect(eventNames(), isNot(contains('chat_resume_download_offered')));
      await bloc.close();
    });

    test('a failed render: no tile', () async {
      when(
        () => resumes.loadResumeHistory(),
      ).thenAnswer((_) async => _history(renderStatus: 'failed'));
      final ChatBloc bloc = await openTab();

      expect(bloc.state.resumeDownloadTile, isFalse);
      await bloc.close();
    });

    test('a throwing history read fails closed: no tile, nothing thrown', () async {
      when(() => resumes.loadResumeHistory()).thenThrow(StateError('boom'));
      final ChatBloc bloc = await openTab();

      expect(bloc.state.resumeDownloadTile, isFalse);
      await bloc.close();
    });

    test('a graph with no résumé repository never offers it', () async {
      final ChatBloc bloc = await openTab(withResumes: false);

      expect(bloc.state.resumeDownloadTile, isFalse);
      verifyNever(() => resumes.loadResumeHistory());
      await bloc.close();
    });

    test('the conversation moving on puts the tile away', () async {
      final ChatBloc bloc = await openTab();
      bloc.add(const ChatMessageSent('naye jobs dikhao'));
      await pumpEventQueue();

      expect(bloc.state.resumeDownloadTile, isFalse);
      // The résumé is kept, so a later ask needs no second read.
      expect(bloc.state.downloadableResumeId, _resumeId);
      verify(
        () => repo.sendCompanionMessage('naye jobs dikhao', submissionId: any(named: 'submissionId')),
      ).called(1);
      await bloc.close();
    });

    test('asking for the résumé brings the tile back and posts NOTHING', () async {
      final ChatBloc bloc = await openTab();
      bloc.add(const ChatMessageSent('naye jobs dikhao'));
      await pumpEventQueue();
      final int before = bloc.state.messages.length;

      bloc.add(const ChatMessageSent(_ask));
      await pumpEventQueue();

      expect(bloc.state.resumeDownloadTile, isTrue);
      final List<ChatMessage> added = bloc.state.messages.sublist(before);
      expect(added.map((ChatMessage m) => m.text), <String>[_ask, kChatResumeDownloadReply]);
      expect(added.first.fromWorker, isTrue);
      expect(added.last.fromWorker, isFalse);
      expect(added.last.ttsText, kChatResumeDownloadReplyTts);
      verifyNever(
        () => repo.sendCompanionMessage(_ask, submissionId: any(named: 'submissionId')),
      );
      verifyNever(
        () => repo.sendMessage(
          any(),
          submissionId: any(named: 'submissionId'),
          answerSource: any(named: 'answerSource'),
        ),
      );
      expect(
        events.where((BbAnalyticsEvent e) => e.name == 'chat_resume_download_offered').last.parameters,
        <String, Object>{'trigger': 'ask'},
      );
      // The chips the worker had are left alone: the ask answered no question.
      expect(bloc.state.suggestedOptions, isNotEmpty);
      await bloc.close();
    });

    test('an ask with no résumé to download is posted exactly as before', () async {
      when(() => resumes.loadResumeHistory()).thenAnswer((_) async => ResumeHistory.empty);
      final ChatBloc bloc = await openTab();

      bloc.add(const ChatMessageSent(_ask));
      await pumpEventQueue();

      expect(bloc.state.resumeDownloadTile, isFalse);
      verify(
        () => repo.sendCompanionMessage(_ask, submissionId: any(named: 'submissionId')),
      ).called(1);
      await bloc.close();
    });

    test('the onboarding chat (no tab offer) never holds an ask back', () async {
      final ChatBloc bloc = build()..add(const ChatStarted());
      await pumpEventQueue();

      bloc.add(const ChatMessageSent(_ask));
      await pumpEventQueue();

      expect(bloc.state.resumeDownloadTile, isFalse);
      verifyNever(() => resumes.loadResumeHistory());
      verify(
        () => repo.sendMessage(
          _ask,
          submissionId: any(named: 'submissionId'),
          answerSource: any(named: 'answerSource'),
        ),
      ).called(1);
      await bloc.close();
    });

    test('a résumé read landing after the worker moved on does not pop the tile back', () async {
      final Completer<ResumeHistory> slow = Completer<ResumeHistory>();
      when(() => resumes.loadResumeHistory()).thenAnswer((_) => slow.future);
      final ChatBloc bloc = build()
        ..add(const ChatCompanionStarted())
        ..add(const ChatResumeDownloadOffered());
      await pumpEventQueue();

      bloc.add(const ChatMessageSent('naye jobs dikhao'));
      await pumpEventQueue();
      slow.complete(_history());
      await pumpEventQueue();

      expect(bloc.state.resumeDownloadTile, isFalse);
      expect(bloc.state.downloadableResumeId, _resumeId);
      await bloc.close();
    });

    test('a spoken ask (already posted by the voice pipeline) still gets the tile', () async {
      final ChatBloc bloc = await openTab();
      bloc.add(const ChatMessageSent('naye jobs dikhao'));
      await pumpEventQueue();
      expect(bloc.state.resumeDownloadTile, isFalse);

      bloc.add(const ChatVoiceMerged(transcript: _ask, reply: 'Theek hai.'));
      await pumpEventQueue();

      expect(bloc.state.resumeDownloadTile, isTrue);
      expect(bloc.state.messages.last.text, 'Theek hai.');
      await bloc.close();
    });

    test('a refocus inside a minute re-offers the tile without a second read', () async {
      final ChatBloc bloc = await openTab();
      bloc.add(const ChatMessageSent('naye jobs dikhao'));
      await pumpEventQueue();

      now = now.add(const Duration(seconds: 30));
      bloc.add(const ChatResumeDownloadOffered());
      await pumpEventQueue();

      expect(bloc.state.resumeDownloadTile, isTrue);
      verify(() => resumes.loadResumeHistory()).called(1);

      now = now.add(const Duration(minutes: 2));
      bloc.add(const ChatResumeDownloadOffered());
      await pumpEventQueue();
      verify(() => resumes.loadResumeHistory()).called(1);
      await bloc.close();
    });

    test('the tap is counted, and the url is minted for the tile\'s résumé', () async {
      when(() => resumes.resumeDownloadUrlFor(_resumeId)).thenAnswer((_) async => 'mock://pdf');
      final ChatBloc bloc = await openTab();

      bloc.add(const ChatResumeDownloadTapped());
      await pumpEventQueue();

      expect(eventNames(), contains('chat_resume_download_tapped'));
      expect(await bloc.resumeDownloadUrl(_resumeId), 'mock://pdf');
      verify(() => resumes.resumeDownloadUrlFor(_resumeId)).called(1);
      await bloc.close();
    });
  });
}
