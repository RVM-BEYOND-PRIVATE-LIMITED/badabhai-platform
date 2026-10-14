import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart';
import 'package:badabhai_worker_app/core/session/chat_turn_resume_store.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_identity_questions.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_message.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_repository.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_resume_prompt.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_session_opening.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_turn.dart';
import 'package:badabhai_worker_app/features/chat/presentation/bloc/chat_bloc.dart';

class MockChatRepository extends Mock implements ChatRepository {}

/// ── `issue10.jpg`: THE PROMPT ANSWERED AFTER A COLD START IS A DEAD END ────
///
/// The worker typed "Rishi Ojha", the server took it as the whole name and
/// asked the state question, the client STASHED that question and showed the
/// résumé prompt over it — then the app closed.
///
/// The stash is in memory and died with the process. On reopen the chips were
/// redrawn from the turn store, and answering them cleared the chips and put
/// NOTHING in their place: the state question's bubble sat in the redrawn
/// transcript with no State picker, no "Location bharein" button and no live
/// ask. The worker was stuck with the LLM asking nothing.
void main() {
  late MockChatRepository repo;
  late InMemoryChatTurnResumeStore store;

  const String stateQuestion = 'Aap kis state mein rehte hain?';

  setUp(() {
    repo = MockChatRepository();
    store = InMemoryChatTurnResumeStore();
    when(() => repo.latestSessionId()).thenAnswer((_) async => 's1');
    when(() => repo.loadHistory()).thenAnswer((_) async => const <ChatMessage>[]);
  });

  /// Session 1 — up to the résumé prompt, then the process dies.
  Future<void> reachThePromptThenDie() async {
    when(() => repo.ensureSession()).thenAnswer(
      (_) async => const ChatSessionOpening(
        text: 'Aapka pehla naam kya hai?',
        questionKey: kChatFirstNameQuestionKey,
      ),
    );
    when(
      () => repo.sendMessage(any(), submissionId: any(named: 'submissionId')),
    ).thenAnswer(
      (_) async => const ChatTurn(
        reply: stateQuestion,
        askedQuestionId: kChatStateQuestionKey,
      ),
    );
    final ChatBloc bloc = ChatBloc(repo, turnResume: store);
    bloc.add(const ChatStarted());
    await Future<void>.delayed(Duration.zero);
    bloc.add(const ChatMessageSent('Rishi Ojha'));
    await Future<void>.delayed(const Duration(milliseconds: 50));
    expect(
      bloc.state.suggestedOptions.map((ChatOption o) => o.optionKey),
      contains(kResumePromptNoResumeKey),
      reason: 'precondition: the prompt stands over the state question',
    );
    await bloc.close();
  }

  /// Session 2 — the app is opened again. No opening question: the session is
  /// a RESUME, so `POST /chat/session` serves no opening (the #2030 premise).
  Future<ChatBloc> reopen() async {
    // A RESUME serves no opening — `_openingFrom` returns null on one, which
    // is the whole premise of the turn store (#2030) and matches issue10.jpg,
    // where bubble 0 is still the canned greeting.
    when(() => repo.ensureSession()).thenAnswer((_) async => null);
    when(() => repo.loadHistory()).thenAnswer(
      (_) async => const <ChatMessage>[
        ChatMessage(text: 'Aapka pehla naam kya hai?', fromWorker: false),
        ChatMessage(text: 'Rishi Ojha', fromWorker: true),
        ChatMessage(text: stateQuestion, fromWorker: false),
      ],
    );
    final ChatBloc bloc = ChatBloc(repo, turnResume: store);
    bloc.add(const ChatStarted());
    await Future<void>.delayed(const Duration(milliseconds: 50));
    return bloc;
  }

  test('the prompt the worker comes back to still carries its question',
      () async {
    await reachThePromptThenDie();
    final ChatBloc bloc = await reopen();
    addTearDown(bloc.close);

    expect(
      bloc.state.suggestedOptions.map((ChatOption o) => o.optionKey),
      contains(kResumePromptNoResumeKey),
      reason: 'the chips are redrawn from the turn store, as before',
    );

    bloc.add(const ChatResumePromptDeclined(kResumePromptNoResumeLabel));
    await Future<void>.delayed(const Duration(milliseconds: 50));

    expect(bloc.state.suggestedOptions, isEmpty);
    expect(
      bloc.state.askedQuestionKey,
      kChatStateQuestionKey,
      reason: 'issue10.jpg: the state question must be LIVE again, not a dead '
          'bubble with no picker and no ask',
    );
    expect(isChatLocationQuestion(bloc.state.askedQuestionKey), isTrue);
  });

  test('the UPLOAD door after a cold start leaves the same live question',
      () async {
    // The same dead end was reachable from the other door: the upload screen's
    // signal answers the prompt on the worker's behalf.
    await reachThePromptThenDie();
    final ChatBloc bloc = await reopen();
    addTearDown(bloc.close);

    bloc.add(const ChatResumePromptDeclined(kResumePromptUploadLabel));
    await Future<void>.delayed(const Duration(milliseconds: 50));

    expect(bloc.state.askedQuestionKey, kChatStateQuestionKey);
  });

  test('a turn with nothing hidden behind the prompt clears the pending key',
      () async {
    await reachThePromptThenDie();
    // A later ordinary turn must not leave the state question pending forever.
    final ChatTurnResumeState? saved = await store.read();
    expect(saved?.pendingQuestionKey, kChatStateQuestionKey);

    await store.write(
      ChatTurnResumeState(
        sessionId: saved!.sessionId,
        options: saved.options,
        freeChat: saved.freeChat,
      ),
    );
    final ChatBloc bloc = await reopen();
    addTearDown(bloc.close);
    bloc.add(const ChatResumePromptDeclined(kResumePromptNoResumeLabel));
    await Future<void>.delayed(const Duration(milliseconds: 50));

    expect(bloc.state.askedQuestionKey, isNull,
        reason: 'no hidden question remembered = exactly the old behaviour');
  });
}
