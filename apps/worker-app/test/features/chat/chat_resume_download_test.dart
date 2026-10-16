import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart'
    show
        ChatOption,
        ChatQuestionKind,
        EditProposal,
        EditProposalRow,
        ResumeHistory,
        ResumeHistoryItem;
import 'package:badabhai_worker_app/core/observability/analytics.dart';
import 'package:badabhai_worker_app/core/session/resume_download_offer_store.dart';
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

const String _otherResumeId = '44444444-4444-4444-8444-444444444444';
final DateTime _firstGeneratedAt = DateTime.utc(2026, 10, 14, 9);

ResumeHistory _history({
  String? renderStatus = 'rendered',
  bool current = true,
  String resumeId = _resumeId,
  DateTime? generatedAt,
  DateTime? renderedAt,
}) => ResumeHistory(
  items: <ResumeHistoryItem>[
    ResumeHistoryItem(
      resumeId: resumeId,
      renderStatus: renderStatus,
      isCurrent: current,
      generatedAt: generatedAt ?? _firstGeneratedAt,
      renderedAt: renderedAt,
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

/// The Bada Bhai tab's "Resume download" tile. OWNER RULING (2026-10-15): it
/// is shown in exactly three cases — (1) the first visit after profiling,
/// (2) a résumé that changed since it was last offered, (3) the worker asking
/// for it (that ask is never posted). Any other open of the chat stays quiet,
/// and the conversation moving on puts it away.
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
      // Case 3 is wider than "download" — see or get the résumé.
      'mera resume dikhao',
      'Resume dikhaiye',
      'show my resume',
      'resume dekhna hai',
      'mera cv kahan hai',
      'resume bhej do',
      'resume print karna hai',
      'show me my resume',
      'cv dikha dijiye',
      'mera resume dikha sakte ho?',
      'send my cv',
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
      // A show word with no résumé named is some other question.
      'salary dikhao',
      'show jobs',
      // A show word beside a change / new-résumé word is the server's.
      'naya resume bana ke dikhao',
      'resume badal ke bhejo',
      'resume update karke dikhao',
      // "In the résumé" is an edit, and "kaha" is "said", not "where".
      'resume mein welding bhi dikhao',
      'resume mein experience dikhana hai',
      'maine kaha tha resume mein welding add karo',
      'resume mein naam likh do',
      // TALK about the résumé — a question about it, never an ask (#2291).
      // Show words are whole words, so these reach the server.
      'kya company ne mera resume dekha?',
      'kitne logon ne mera resume dekha hai',
      'mera resume kis company ko bheja gaya?',
      'resume bheja tha company ko, reply nahi aaya',
      'resume bhejne ke baad kya hoga',
      'resume dekh ke job milegi kya',
      'maine resume dekha',
      'resume printing wali company ko bhi jayega?',
    ]) {
      test('"$other" is NOT a download request', () {
        expect(isResumeDownloadRequest(other), isFalse);
      });
    }

    // On an interview every typed message is an answer, so the ask must name
    // the résumé as well — a skill answer that mentions a PDF stays an answer.
    test('requireResumeWord: a download word alone is not enough', () {
      for (final String answer in <String>[
        'PDF banana aata hai',
        'app download kiya hai',
        'download',
      ]) {
        expect(
          isResumeDownloadRequest(answer, requireResumeWord: true),
          isFalse,
          reason: answer,
        );
      }
      for (final String ask in <String>[
        _ask,
        'CV ka pdf chahiye',
        'biodata download',
        'रिज़्यूमे डाउनलोड करना है',
        'mera resume dikhao',
      ]) {
        expect(
          isResumeDownloadRequest(ask, requireResumeWord: true),
          isTrue,
          reason: ask,
        );
      }
    });

    // The investor demo's four phrases — on the companion AND on a tab that is
    // on the interview (an unfinished form, or the companion lever off).
    test('the four demo asks are asks on the companion and on an interview', () {
      for (final String ask in <String>[
        'resume dikhao',
        'resume bhej do',
        'resume download',
        'pdf bhej do',
      ]) {
        expect(isResumeDownloadRequest(ask), isTrue, reason: ask);
        expect(
          isResumeDownloadRequest(ask, requireResumeWord: true),
          isTrue,
          reason: '$ask (interview)',
        );
      }
    });

    test('requireResumeWord: a download word that ASKS for the file is a request; '
        'one that only mentions a PDF or a download is still an answer', () {
      for (final String ask in <String>[
        'pdf bhej do',
        'PDF bhej do bhai',
        'pdf dikhao',
        'pdf dikha do',
        'mujhe pdf dikhaiye',
        'पीडीएफ भेज दो',
      ]) {
        expect(
          isResumeDownloadRequest(ask, requireResumeWord: true),
          isTrue,
          reason: ask,
        );
      }
      for (final String answer in <String>[
        'PDF banana aata hai',
        'app download kiya hai',
        'download',
        'pdf bheja tha',
        'kya maine pdf bheja tha',
        'drawing ki pdf padh leta hoon',
        // A worker DESCRIBING a skill — ability, infinitive, English verbs —
        // is answering the open question, never asking for the file.
        'haan, pdf print kar leta hoon',
        'computer pe pdf dekh sakta hoon',
        'mobile se pdf bhejna aata hai',
        'WhatsApp pe PDF bhejna aata hai',
        'Haan, mobile se PDF bhej sakta hoon',
        'PDF print karna aata hai',
        'MS Office, PDF, print sab aata hai',
        'files download karke email se send karta hoon',
        'download karke dekh sakta hoon',
        'pdf send kar deta hoon',
        'pdf kahan milega',
        'पीडीएफ भेज दोगे?',
        // A show word beside an edit / new-résumé / "in it" word stays the
        // server's, exactly as it does for a named résumé.
        'pdf mein naam badal ke bhej do',
        'naya pdf bana ke dikhao',
      ]) {
        expect(
          isResumeDownloadRequest(answer, requireResumeWord: true),
          isFalse,
          reason: answer,
        );
      }
    });

    // The dictation mic's Send posts the recogniser's text as it came, and a
    // Hindi-locale recogniser writes a spoken "resume dikhao" in Hindi script.
    test('a SPOKEN ask in Hindi script is an ask — both nukta spellings', () {
      for (final String ask in <String>[
        'रिज़्यूमे दिखाओ',
        'रिज़्यूमे दिखाओ',
        'मेरा रिज़्यूमे भेज दो',
        'रिज्यूमे भेजिए',
        'रिज़्यूमे डाउनलोड',
        'मेरा रिज़्यूमे कहाँ है',
        'पीडीएफ़ भेज दो',
      ]) {
        expect(isResumeDownloadRequest(ask), isTrue, reason: ask);
        expect(
          isResumeDownloadRequest(ask, requireResumeWord: true),
          isTrue,
          reason: '$ask (interview)',
        );
      }
    });

    test('Hindi-script TALK about the résumé, an edit or a new one is never an ask', () {
      for (final String talk in <String>[
        'क्या कंपनी ने मेरा रिज़्यूमे देखा?',
        'रिज़्यूमे भेजा था',
        'रिज़्यूमे दिखाया था',
        'रिज़्यूमे में वेल्डिंग भी दिखाओ',
        'नया रिज़्यूमे बना के दिखाओ',
        'रिज़्यूमे बदल के भेज दो',
        'नौकरी दिखाओ',
        // WHOLE tokens, like the Latin rule: "will you send it?" is talk.
        'रिज़्यूमे कंपनी को भेज दोगे?',
        'क्या आप मेरा रिज़्यूमे कंपनी को भेज दोगे',
        // The edit / new-résumé words a recogniser writes in Hindi script.
        'रिज़्यूम चेंज करके भेज दो',
        'रिज़्यूम गलत है ठीक करके भेज दो',
        'नयी रिज़्यूम भेज दो',
        'न्यू रिज़्यूम दिखाओ',
        'स्किल जोड़कर रिज्यूमे दिखाओ',
      ]) {
        expect(isResumeDownloadRequest(talk), isFalse, reason: talk);
      }
    });

    test('a precomposed nukta letter reads exactly like letter + nukta sign — '
        'in the ask AND in its guards', () {
      // ज़ (U+095B), फ़ (U+095E), ड़ (U+095C) and ग़ (U+095A) as ONE code point.
      final String za = String.fromCharCode(0x095B);
      final String fa = String.fromCharCode(0x095E);
      final String rra = String.fromCharCode(0x095C);
      final String gha = String.fromCharCode(0x095A);
      for (final String ask in <String>[
        'रि$za्यूमे दिखाओ',
        'रि$za्यूमे डाउनलोड',
        'पीडीए$fa भेज दो',
      ]) {
        expect(isResumeDownloadRequest(ask, requireResumeWord: true), isTrue, reason: ask);
      }
      for (final String edit in <String>[
        'स्किल जो$rraकर रिज्यूमे दिखाओ',
        'रि$za्यूम $ghaलत है ठीक करके भेज दो',
      ]) {
        expect(isResumeDownloadRequest(edit), isFalse, reason: edit);
      }
    });
  });

  group('downloadableResumeIn', () {
    test('the CURRENT row, rendered or still rendering', () {
      expect(downloadableResumeIn(_history())?.id, _resumeId);
      expect(downloadableResumeIn(_history(renderStatus: 'pending'))?.id, _resumeId);
      expect(downloadableResumeIn(_history(renderStatus: null))?.id, _resumeId);
    });

    test('nothing for no history, no current row, or a FAILED render', () {
      expect(downloadableResumeIn(ResumeHistory.empty), isNull);
      expect(downloadableResumeIn(_history(current: false)), isNull);
      expect(downloadableResumeIn(_history(renderStatus: 'failed')), isNull);
    });

    test('a still-rendering résumé is flagged pending; rendered and unknown are not', () {
      expect(downloadableResumeIn(_history(renderStatus: 'pending'))!.pending, isTrue);
      expect(downloadableResumeIn(_history())!.pending, isFalse);
      expect(downloadableResumeIn(_history(renderStatus: null))!.pending, isFalse);
    });

    test('isUnofferedResume: new, re-generated and RE-rendered count; a first render does not', () {
      final DownloadableResume pending = downloadableResumeIn(
        _history(renderStatus: 'pending'),
      )!;
      final DownloadableResume rendered = downloadableResumeIn(
        _history(renderedAt: DateTime.utc(2026, 10, 14, 9, 1)),
      )!;
      final DownloadableResume reRendered = downloadableResumeIn(
        _history(renderedAt: DateTime.utc(2026, 10, 15, 10)),
      )!;
      final DownloadableResume regenerated = downloadableResumeIn(
        _history(generatedAt: DateTime.utc(2026, 10, 15)),
      )!;

      expect(isUnofferedResume(null, rendered), isTrue, reason: 'never offered');
      expect(isUnofferedResume(rendered.token, rendered), isFalse, reason: 'same');
      expect(isUnofferedResume(pending.token, rendered), isFalse, reason: 'first render finished');
      expect(isUnofferedResume(rendered.token, pending), isFalse, reason: 're-render running');
      expect(isUnofferedResume(rendered.token, reRendered), isTrue, reason: 'Resume Edit re-render');
      expect(isUnofferedResume(rendered.token, regenerated), isTrue, reason: 're-generated');
    });

    test('the VERSION moves with a new or re-generated résumé, not with a render', () {
      final String v1 = downloadableResumeIn(_history(renderStatus: 'pending'))!.version;
      expect(downloadableResumeIn(_history())!.version, v1, reason: 'render finished');
      expect(
        downloadableResumeIn(_history(generatedAt: DateTime.utc(2026, 10, 15)))!.version,
        isNot(v1),
        reason: 're-generated',
      );
      expect(
        downloadableResumeIn(_history(resumeId: _otherResumeId))!.version,
        isNot(v1),
        reason: 'a new résumé',
      );
    });
  });

  group('ChatBloc — the tile', () {
    late MockChatRepository repo;
    late MockResumeRepository resumes;
    late List<BbAnalyticsEvent> events;
    late DateTime now;
    late InMemoryResumeDownloadOfferStore offers;

    setUp(() {
      repo = MockChatRepository();
      resumes = MockResumeRepository();
      events = <BbAnalyticsEvent>[];
      offers = InMemoryResumeDownloadOfferStore();
      ChatBloc.resumeChangeWatchInterval = Duration.zero;
      ChatBloc.resumeChangeWatchAttempts = 3;
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

    tearDown(() {
      ChatBloc.resumeChangeWatchInterval = const Duration(seconds: 4);
      ChatBloc.resumeChangeWatchAttempts = 30;
    });

    ChatBloc build({bool withResumes = true}) => ChatBloc(
      repo,
      analyticsSink: events.add,
      clock: () => now,
      resumeRepository: withResumes ? resumes : null,
      resumeDownloadOffers: offers,
    );

    Future<ChatBloc> openTab({bool withResumes = true}) async {
      final ChatBloc bloc = build(withResumes: withResumes)
        ..add(const ChatCompanionStarted())
        ..add(const ChatResumeDownloadOffered());
      await pumpEventQueue();
      return bloc;
    }

    Iterable<String> eventNames() => events.map((BbAnalyticsEvent e) => e.name);

    List<Object> offeredTriggers() => <Object>[
      for (final BbAnalyticsEvent e in events)
        if (e.name == 'chat_resume_download_offered') e.parameters['trigger']!,
    ];

    test('case 1: the first visit offers the tile for the current résumé', () async {
      final ChatBloc bloc = await openTab();

      expect(bloc.state.resumeDownloadTile, isTrue);
      expect(bloc.state.downloadableResumeId, _resumeId);
      expect(offeredTriggers(), <Object>['first']);
      expect(await offers.lastOffered(), downloadableResumeIn(_history())!.token);
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

    test('#2302: on the companion a typed download ask is POSTED once — the server answers it, nothing local', () async {
      const String serverLine = 'Aapka resume taiyaar hai. Neeche button dabakar download karein.';
      final ChatBloc bloc = await openTab();
      bloc.add(const ChatMessageSent('naye jobs dikhao'));
      await pumpEventQueue();
      when(
        () => repo.sendCompanionMessage(_ask, submissionId: any(named: 'submissionId')),
      ).thenAnswer(
        (_) async => const ChatTurn(
          reply: serverLine,
          companion: true,
          suggestedOptions: <ChatOption>[
            ChatOption(optionKey: 'companion_resume_download', labelText: 'Resume download karein'),
          ],
        ),
      );
      final int before = bloc.state.messages.length;

      bloc.add(const ChatMessageSent(_ask));
      await pumpEventQueue();

      verify(
        () => repo.sendCompanionMessage(_ask, submissionId: any(named: 'submissionId')),
      ).called(1);
      final List<ChatMessage> added = bloc.state.messages.sublist(before);
      expect(added.map((ChatMessage m) => m.text), <String>[_ask, serverLine]);
      expect(
        bloc.state.messages.map((ChatMessage m) => m.text),
        isNot(contains(kChatResumeDownloadReply)),
        reason: 'no local reply: it would vanish from the 7-day history',
      );
      // The server's own download chip is what the worker taps.
      expect(
        bloc.state.suggestedOptions.map((ChatOption o) => o.optionKey),
        contains('companion_resume_download'),
      );
      expect(offeredTriggers(), isNot(contains('ask')));
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
      // It was never SEEN, so it is not spent: the next open offers it.
      expect(await offers.lastOffered(), isNull);
      when(() => resumes.loadResumeHistory()).thenAnswer((_) async => _history());
      bloc.add(const ChatResumeDownloadOffered());
      await pumpEventQueue();
      expect(bloc.state.resumeDownloadTile, isTrue);
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

    test('opening the chat again with the SAME résumé stays quiet', () async {
      final ChatBloc bloc = await openTab();
      bloc.add(const ChatMessageSent('naye jobs dikhao'));
      await pumpEventQueue();
      expect(bloc.state.resumeDownloadTile, isFalse);

      // The worker flips away and back (a refocus) — twice.
      bloc
        ..add(const ChatResumeDownloadOffered())
        ..add(const ChatResumeDownloadOffered());
      await pumpEventQueue();

      expect(bloc.state.resumeDownloadTile, isFalse);
      expect(offeredTriggers(), <Object>['first']);
      // The résumé is still known, so an ask needs no second thought.
      expect(bloc.state.downloadableResumeId, _resumeId);
      await bloc.close();
    });

    test('a cold start (a new chat on the same phone) does not offer the same résumé again', () async {
      final ChatBloc first = await openTab();
      expect(first.state.resumeDownloadTile, isTrue);
      await first.close();

      final ChatBloc second = await openTab();
      expect(second.state.resumeDownloadTile, isFalse);
      expect(offeredTriggers(), <Object>['first']);
      await second.close();
    });

    test('case 2: a résumé that CHANGED while away is offered on the next open', () async {
      final ChatBloc bloc = await openTab();
      bloc.add(const ChatMessageSent('naye jobs dikhao'));
      await pumpEventQueue();
      expect(bloc.state.resumeDownloadTile, isFalse);

      // Edited on the Résumé tab: the same row, re-generated.
      when(() => resumes.loadResumeHistory()).thenAnswer(
        (_) async => _history(generatedAt: DateTime.utc(2026, 10, 15, 8)),
      );
      bloc.add(const ChatResumeDownloadOffered());
      await pumpEventQueue();
      expect(bloc.state.resumeDownloadTile, isTrue);

      // A brand-new résumé (a new row) counts the same way.
      bloc.add(const ChatMessageSent('naye jobs dikhao'));
      await pumpEventQueue();
      when(
        () => resumes.loadResumeHistory(),
      ).thenAnswer((_) async => _history(resumeId: _otherResumeId));
      bloc.add(const ChatResumeDownloadOffered());
      await pumpEventQueue();
      expect(bloc.state.resumeDownloadTile, isTrue);
      expect(bloc.state.downloadableResumeId, _otherResumeId);

      expect(offeredTriggers(), <Object>['first', 'changed', 'changed']);
      await bloc.close();
    });

    test('case 3 on the companion is the SERVER\'s chip: its tap answers on the phone and marks the résumé offered', () async {
      // The worker has already been offered this résumé on an earlier visit.
      await offers.markOffered(downloadableResumeIn(_history())!.token);
      final ChatBloc bloc = await openTab();
      expect(bloc.state.resumeDownloadTile, isFalse);

      bloc.add(const ChatResumeDownloadChipTapped('Resume download karein'));
      await pumpEventQueue();
      expect(bloc.state.resumeDownloadTile, isTrue);
      expect(bloc.state.messages.last.text, kChatResumeDownloadReply);
      verifyNever(
        () => repo.sendCompanionMessage(
          'Resume download karein',
          submissionId: any(named: 'submissionId'),
        ),
      );
      expect(offeredTriggers(), <Object>['ask']);
      await bloc.close();
    });

    test('case 2 inside the chat: Haan on an edit card offers the regenerated résumé when it lands', () async {
      const String proposalId = '55555555-5555-4555-8555-555555555555';
      final EditProposal card = EditProposal(
        proposalId: proposalId,
        expiresAt: DateTime.now().add(const Duration(minutes: 10)),
        rows: const <EditProposalRow>[
          EditProposalRow(rowId: 'r1', sectionLabel: 'Skills', op: 'add', after: 'Welding'),
        ],
      );
      ResumeHistory current = _history();
      when(() => resumes.loadResumeHistory()).thenAnswer((_) async => current);
      final ChatBloc bloc = await openTab();
      when(
        () => repo.sendCompanionMessage('Resume badlo', submissionId: any(named: 'submissionId')),
      ).thenAnswer(
        (_) async => ChatTurn(
          reply: 'Yeh badlav karne hain?',
          companion: true,
          editProposal: card,
        ),
      );
      bloc.add(const ChatMessageSent('Resume badlo'));
      await pumpEventQueue();
      expect(bloc.state.editProposal, isNotNull);
      expect(bloc.state.resumeDownloadTile, isFalse);

      when(
        () => repo.confirmCompanionEdit(proposalId, <String>['r1'], submissionId: any(named: 'submissionId')),
      ).thenAnswer((_) async {
        // The queued generation lands: the same row, re-generated.
        current = _history(generatedAt: DateTime.utc(2026, 10, 15, 8));
        return CompanionEditResult.served(
          const ChatTurn(reply: 'Badlav ho gaya. Aapka resume update ho raha hai.', companion: true),
        );
      });
      bloc.add(const ChatEditProposalConfirmed(<String>['r1']));
      await pumpEventQueue();

      expect(bloc.state.resumeDownloadTile, isTrue);
      expect(offeredTriggers(), <Object>['first', 'changed']);
      await bloc.close();
    });

    test('a Resume Edit re-render (same résumé, new PDF) counts as changed; a first render does not', () async {
      // Offered while the first render was still running.
      when(
        () => resumes.loadResumeHistory(),
      ).thenAnswer((_) async => _history(renderStatus: 'pending'));
      final ChatBloc bloc = await openTab();
      expect(offeredTriggers(), <Object>['first']);
      bloc.add(const ChatMessageSent('naye jobs dikhao'));
      await pumpEventQueue();

      // The first render finishes: the SAME résumé — quiet.
      when(() => resumes.loadResumeHistory()).thenAnswer(
        (_) async => _history(renderedAt: DateTime.utc(2026, 10, 14, 9, 1)),
      );
      bloc.add(const ChatResumeDownloadOffered());
      await pumpEventQueue();
      expect(bloc.state.resumeDownloadTile, isFalse);

      // A Resume Edit (name / photo) re-renders it: changed.
      when(() => resumes.loadResumeHistory()).thenAnswer(
        (_) async => _history(renderedAt: DateTime.utc(2026, 10, 15, 10)),
      );
      bloc.add(const ChatResumeChangeWatchRequested());
      await pumpEventQueue();
      expect(bloc.state.resumeDownloadTile, isTrue);
      expect(offeredTriggers(), <Object>['first', 'changed']);
      await bloc.close();
    });

    test('an edit card handed back (nothing written) starts no watch', () async {
      const String proposalId = '77777777-7777-4777-8777-777777777777';
      final EditProposal card = EditProposal(
        proposalId: proposalId,
        expiresAt: DateTime.now().add(const Duration(minutes: 10)),
        rows: const <EditProposalRow>[
          EditProposalRow(rowId: 'r1', sectionLabel: 'Skills', op: 'add', after: 'Welding'),
        ],
      );
      final ChatBloc bloc = await openTab();
      when(
        () => repo.sendCompanionMessage('Resume badlo', submissionId: any(named: 'submissionId')),
      ).thenAnswer(
        (_) async => ChatTurn(reply: 'Yeh badlav karne hain?', companion: true, editProposal: card),
      );
      bloc.add(const ChatMessageSent('Resume badlo'));
      await pumpEventQueue();
      clearInteractions(resumes);
      when(
        () => repo.confirmCompanionEdit(proposalId, <String>['r1'], submissionId: any(named: 'submissionId')),
      ).thenAnswer(
        (_) async => CompanionEditResult.served(
          ChatTurn(reply: 'Abhi nahi ho paya.', companion: true, editProposal: card),
        ),
      );
      bloc.add(const ChatEditProposalConfirmed(<String>['r1']));
      await pumpEventQueue();

      verifyNever(() => resumes.loadResumeHistory());
      expect(bloc.state.resumeDownloadTile, isFalse);
      await bloc.close();
    });

    test('an edit whose résumé never changes offers nothing', () async {
      const String proposalId = '66666666-6666-4666-8666-666666666666';
      final ChatBloc bloc = await openTab();
      when(
        () => repo.sendCompanionMessage('Resume badlo', submissionId: any(named: 'submissionId')),
      ).thenAnswer(
        (_) async => ChatTurn(
          reply: 'Yeh badlav karne hain?',
          companion: true,
          editProposal: EditProposal(
            proposalId: proposalId,
            expiresAt: DateTime.now().add(const Duration(minutes: 10)),
            rows: const <EditProposalRow>[
              EditProposalRow(rowId: 'r1', sectionLabel: 'Skills', op: 'add', after: 'Welding'),
            ],
          ),
        ),
      );
      bloc.add(const ChatMessageSent('Resume badlo'));
      await pumpEventQueue();
      when(
        () => repo.confirmCompanionEdit(proposalId, <String>['r1'], submissionId: any(named: 'submissionId')),
      ).thenAnswer(
        (_) async => CompanionEditResult.served(
          const ChatTurn(reply: 'Resume abhi update nahi hua.', companion: true),
        ),
      );
      bloc.add(const ChatEditProposalConfirmed(<String>['r1']));
      await pumpEventQueue();

      expect(bloc.state.resumeDownloadTile, isFalse);
      expect(offeredTriggers(), <Object>['first']);
      await bloc.close();
    });

    test('on an interview, an answer that only mentions a PDF is posted as the answer', () async {
      final ChatBloc bloc = build()
        ..add(const ChatStarted())
        ..add(const ChatResumeDownloadOffered());
      await pumpEventQueue();
      expect(bloc.state.companion, isFalse);
      expect(bloc.state.resumeDownloadTile, isTrue);

      bloc.add(const ChatMessageSent('PDF banana aata hai'));
      await pumpEventQueue();
      expect(bloc.state.resumeDownloadTile, isFalse);
      verify(
        () => repo.sendMessage(
          'PDF banana aata hai',
          submissionId: any(named: 'submissionId'),
          answerSource: any(named: 'answerSource'),
        ),
      ).called(1);

      // Naming the résumé makes it an ask, even mid-interview.
      bloc.add(const ChatMessageSent('mera resume download karna hai'));
      await pumpEventQueue();
      expect(bloc.state.resumeDownloadTile, isTrue);
      expect(bloc.state.messages.last.text, kChatResumeDownloadReply);
      verifyNever(
        () => repo.sendMessage(
          'mera resume download karna hai',
          submissionId: any(named: 'submissionId'),
          answerSource: any(named: 'answerSource'),
        ),
      );
      await bloc.close();
    });

    test('a CHIP tap is never held back, whatever its label says', () async {
      final ChatBloc bloc = await openTab();

      bloc.add(
        const ChatMessageSent(
          'Resume download',
          optionKey: 'some_chip',
          servedOption: true,
        ),
      );
      await pumpEventQueue();

      verify(
        () => repo.sendCompanionMessage('Resume download', submissionId: any(named: 'submissionId')),
      ).called(1);
      expect(bloc.state.messages.last.text, isNot(kChatResumeDownloadReply));
      await bloc.close();
    });

    test('an ask typed while a reply is still in flight is posted, not answered locally', () async {
      final ChatBloc bloc = await openTab();
      final Completer<ChatTurn?> pending = Completer<ChatTurn?>();
      when(
        () => repo.sendCompanionMessage('naye jobs dikhao', submissionId: any(named: 'submissionId')),
      ).thenAnswer((_) => pending.future);

      bloc.add(const ChatMessageSent('naye jobs dikhao'));
      await pumpEventQueue();
      expect(bloc.state.sending, isTrue);
      bloc.add(const ChatMessageSent(_ask));
      await pumpEventQueue();

      verify(
        () => repo.sendCompanionMessage(_ask, submissionId: any(named: 'submissionId')),
      ).called(1);
      expect(
        bloc.state.messages.map((ChatMessage m) => m.text),
        isNot(contains(kChatResumeDownloadReply)),
      );
      pending.complete(_companion('Kisi job par dabakar poori jaankari dekhein.'));
      await pumpEventQueue();
      await bloc.close();
    });

    test('the recap replacing an interview on refocus keeps the tile', () async {
      when(() => repo.forgetSession()).thenReturn(null);
      final ChatBloc bloc = build()
        ..add(const ChatStarted())
        ..add(const ChatResumeDownloadOffered());
      await pumpEventQueue();
      expect(bloc.state.companion, isFalse);
      expect(bloc.state.resumeDownloadTile, isTrue);

      bloc.add(const ChatCompanionRefreshRequested());
      await pumpEventQueue();

      expect(bloc.state.companion, isTrue);
      expect(bloc.state.messages.map((ChatMessage m) => m.text).toList(), <String>[_recap]);
      expect(bloc.state.resumeDownloadTile, isTrue);
      expect(bloc.state.downloadableResumeId, _resumeId);
      await bloc.close();
    });

    test('two offers before the first read returns share ONE read and count ONE offer', () async {
      final Completer<ResumeHistory> slow = Completer<ResumeHistory>();
      when(() => resumes.loadResumeHistory()).thenAnswer((_) => slow.future);
      final ChatBloc bloc = build()
        ..add(const ChatCompanionStarted())
        ..add(const ChatResumeDownloadOffered())
        ..add(const ChatResumeDownloadOffered());
      await pumpEventQueue();
      slow.complete(_history());
      await pumpEventQueue();

      expect(bloc.state.resumeDownloadTile, isTrue);
      verify(() => resumes.loadResumeHistory()).called(1);
      expect(
        events.where((BbAnalyticsEvent e) => e.name == 'chat_resume_download_offered'),
        hasLength(1),
      );
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

    // ── Honest answers (G4) ────────────────────────────────────────────────

    test('an ask while the PDF is still being made says so — never "taiyaar hai" — '
        'and still offers the tile, which waits the render out', () async {
      when(
        () => resumes.loadResumeHistory(),
      ).thenAnswer((_) async => _history(renderStatus: 'pending'));
      final ChatBloc bloc = await openTab();
      bloc.add(const ChatMessageSent('naye jobs dikhao'));
      await pumpEventQueue();

      bloc.add(const ChatMessageSent('resume dikhao'));
      await pumpEventQueue();

      expect(bloc.state.messages.last.text, kChatResumeDownloadPendingReply);
      expect(bloc.state.messages.last.ttsText, kChatResumeDownloadPendingReplyTts);
      expect(bloc.state.resumeDownloadTile, isTrue);
      expect(bloc.state.downloadableResumeId, _resumeId);
      verifyNever(
        () => repo.sendCompanionMessage('resume dikhao', submissionId: any(named: 'submissionId')),
      );
      await bloc.close();
    });

    test('on the companion, every demo ask for a résumé whose PDF FAILED gets the '
        'honest line and no tile — and is never posted', () async {
      when(
        () => resumes.loadResumeHistory(),
      ).thenAnswer((_) async => _history(renderStatus: 'failed'));
      final ChatBloc bloc = await openTab();

      for (final String ask in <String>[
        'resume dikhao',
        'resume bhej do',
        'resume download',
        'pdf bhej do',
      ]) {
        bloc.add(ChatMessageSent(ask));
        await pumpEventQueue();
        final List<ChatMessage> tail = bloc.state.messages.sublist(
          bloc.state.messages.length - 2,
        );
        expect(tail.map((ChatMessage m) => m.text), <String>[ask, kChatResumeDownloadFailedReply]);
        expect(tail.last.ttsText, kChatResumeDownloadFailedReplyTts);
        expect(bloc.state.resumeDownloadTile, isFalse, reason: ask);
        expect(bloc.state.downloadableResumeId, isNull, reason: ask);
      }
      verifyNever(
        () => repo.sendCompanionMessage(any(), submissionId: any(named: 'submissionId')),
      );
      // Nothing was offered, so nothing is counted as offered.
      expect(eventNames(), isNot(contains('chat_resume_download_offered')));
      await bloc.close();
    });

    test('on an INTERVIEW, an ask for a failed PDF is answered, never captured as '
        'the open question\'s answer', () async {
      when(
        () => resumes.loadResumeHistory(),
      ).thenAnswer((_) async => _history(renderStatus: 'failed'));
      final ChatBloc bloc = build()
        ..add(const ChatStarted())
        ..add(const ChatResumeDownloadOffered());
      await pumpEventQueue();
      expect(bloc.state.companion, isFalse);

      bloc.add(const ChatMessageSent('mera resume download karna hai'));
      await pumpEventQueue();

      expect(bloc.state.messages.last.text, kChatResumeDownloadFailedReply);
      expect(bloc.state.resumeDownloadTile, isFalse);
      verifyNever(
        () => repo.sendMessage(
          any(),
          submissionId: any(named: 'submissionId'),
          answerSource: any(named: 'answerSource'),
        ),
      );
      await bloc.close();
    });

    test('the server download chip, tapped after the render failed: the honest '
        'line, nothing posted', () async {
      final ChatBloc bloc = await openTab();
      when(
        () => resumes.loadResumeHistory(),
      ).thenAnswer((_) async => _history(renderStatus: 'failed'));

      bloc.add(const ChatResumeDownloadChipTapped('Resume download karein'));
      await pumpEventQueue();

      expect(bloc.state.messages.last.text, kChatResumeDownloadFailedReply);
      expect(bloc.state.resumeDownloadTile, isFalse);
      verifyNever(
        () => repo.sendCompanionMessage(any(), submissionId: any(named: 'submissionId')),
      );
      await bloc.close();
    });

    test('"pdf bhej do" on an interview is an ask, not the open question\'s answer', () async {
      final ChatBloc bloc = build()
        ..add(const ChatStarted())
        ..add(const ChatResumeDownloadOffered());
      await pumpEventQueue();
      expect(bloc.state.companion, isFalse);
      bloc.add(const ChatMessageSent('5 saal'));
      await pumpEventQueue();
      expect(bloc.state.resumeDownloadTile, isFalse);

      bloc.add(const ChatMessageSent('pdf bhej do'));
      await pumpEventQueue();

      expect(bloc.state.resumeDownloadTile, isTrue);
      expect(bloc.state.messages.last.text, kChatResumeDownloadReply);
      verifyNever(
        () => repo.sendMessage(
          'pdf bhej do',
          submissionId: any(named: 'submissionId'),
          answerSource: any(named: 'answerSource'),
        ),
      );
      await bloc.close();
    });

    // ── An unreadable history is not "no résumé" (G1 / G2) ─────────────────

    test('a refocus whose history read FAILED keeps the tile on screen, with its id', () async {
      final ChatBloc bloc = await openTab();
      expect(bloc.state.resumeDownloadTile, isTrue);

      // The worker flips away and back; that read fails — offline, a 5xx and a
      // timeout all come back from the repository as the empty history.
      when(() => resumes.loadResumeHistory()).thenAnswer((_) async => ResumeHistory.empty);
      bloc.add(const ChatResumeDownloadOffered());
      await pumpEventQueue();

      expect(bloc.state.resumeDownloadTile, isTrue);
      expect(bloc.state.downloadableResumeId, _resumeId);
      await bloc.close();
    });

    test('a history that SAYS the render failed does take the tile away', () async {
      final ChatBloc bloc = await openTab();
      when(
        () => resumes.loadResumeHistory(),
      ).thenAnswer((_) async => _history(renderStatus: 'failed'));

      bloc.add(const ChatResumeDownloadOffered());
      await pumpEventQueue();

      expect(bloc.state.resumeDownloadTile, isFalse);
      expect(bloc.state.downloadableResumeId, isNull);
      await bloc.close();
    });

    test('an ask whose history read failed still gets the tile for the résumé the '
        'tab already offered — nothing posted', () async {
      final ChatBloc bloc = await openTab();
      bloc.add(const ChatMessageSent('naye jobs dikhao'));
      await pumpEventQueue();
      expect(bloc.state.resumeDownloadTile, isFalse);

      when(() => resumes.loadResumeHistory()).thenThrow(StateError('offline'));
      bloc.add(const ChatMessageSent(_ask));
      await pumpEventQueue();

      expect(bloc.state.resumeDownloadTile, isTrue);
      expect(bloc.state.downloadableResumeId, _resumeId);
      expect(bloc.state.messages.last.text, kChatResumeDownloadReply);
      verifyNever(
        () => repo.sendCompanionMessage(_ask, submissionId: any(named: 'submissionId')),
      );
      await bloc.close();
    });

    test('an ask whose read failed says what was last SEEN — a résumé last seen '
        'rendering is never "taiyaar hai"', () async {
      when(
        () => resumes.loadResumeHistory(),
      ).thenAnswer((_) async => _history(renderStatus: 'pending'));
      final ChatBloc bloc = await openTab();
      bloc.add(const ChatMessageSent('naye jobs dikhao'));
      await pumpEventQueue();

      when(() => resumes.loadResumeHistory()).thenAnswer((_) async => ResumeHistory.empty);
      bloc.add(const ChatMessageSent('resume dikhao'));
      await pumpEventQueue();

      expect(bloc.state.messages.last.text, kChatResumeDownloadPendingReply);
      expect(bloc.state.resumeDownloadTile, isTrue);
      expect(bloc.state.downloadableResumeId, _resumeId);
      await bloc.close();
    });

    test('the tile\'s wait reads its résumé\'s render state from the history', () async {
      when(
        () => resumes.loadResumeHistory(),
      ).thenAnswer((_) async => _history(renderStatus: 'pending'));
      final ChatBloc bloc = await openTab();

      expect(await bloc.resumeRenderStatus(_resumeId), 'pending');
      expect(await bloc.resumeRenderStatus(_otherResumeId), isNull);
      await bloc.close();
    });
  });
}
