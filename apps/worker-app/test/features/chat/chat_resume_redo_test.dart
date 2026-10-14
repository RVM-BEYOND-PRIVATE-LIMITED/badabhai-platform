import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/session/resume_redo_store.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_message.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_repository.dart';
import 'package:badabhai_worker_app/features/chat/presentation/bloc/chat_bloc.dart';
import 'package:badabhai_worker_app/features/trade_form/presentation/open_trade_form.dart';

class MockChatRepository extends Mock implements ChatRepository {}

/// ── "Chat se resume banayein" must hand over to a BLANK form ───────────────
///
/// The chat is where the re-do is known — `ChatSessionRestarted` has exactly
/// one dispatcher, the post-completion menu's "Chat se resume banayein". The
/// form is opened later, possibly after the app was closed, so the mark has to
/// outlive the process.
void main() {
  late MockChatRepository repo;
  late InMemoryResumeRedoStore store;

  setUp(() {
    repo = MockChatRepository();
    store = InMemoryResumeRedoStore();
    when(() => repo.ensureSession()).thenAnswer((_) async => null);
    when(() => repo.startNewSession()).thenAnswer((_) async => null);
    when(() => repo.loadHistory())
        .thenAnswer((_) async => const <ChatMessage>[]);
  });

  Future<void> settle() => Future<void>.delayed(const Duration(milliseconds: 30));

  test('an ordinary chat is not a re-do', () async {
    when(() => repo.latestSessionId()).thenAnswer((_) async => 's-first');
    final ChatBloc bloc = ChatBloc(repo, resumeRedo: store);
    addTearDown(bloc.close);
    bloc.add(const ChatStarted());
    await settle();

    expect(bloc.state.redoSession, isFalse);
    expect(await store.isRedo('s-first'), isFalse);
  });

  test('"Chat se resume banayein" marks the NEW session as a re-do', () async {
    String live = 's-old';
    when(() => repo.latestSessionId()).thenAnswer((_) async => live);
    when(() => repo.startNewSession()).thenAnswer((_) async {
      live = 's-redo';
      return null;
    });
    final ChatBloc bloc = ChatBloc(repo, resumeRedo: store);
    addTearDown(bloc.close);
    bloc.add(const ChatStarted());
    await settle();

    bloc.add(const ChatSessionRestarted());
    await settle();

    expect(bloc.state.redoSession, isTrue);
    expect(await store.isRedo('s-redo'), isTrue);
    expect(await store.isRedo('s-old'), isFalse,
        reason: 'only the session minted for the re-do');
  });

  test('a COLD START into the re-do session still knows', () async {
    await store.markRedo('s-redo');
    when(() => repo.latestSessionId()).thenAnswer((_) async => 's-redo');
    final ChatBloc bloc = ChatBloc(repo, resumeRedo: store);
    addTearDown(bloc.close);
    bloc.add(const ChatStarted());
    await settle();

    expect(bloc.state.redoSession, isTrue);
  });

  test('a stale mark never blanks a different session', () async {
    await store.markRedo('s-redo');
    when(() => repo.latestSessionId()).thenAnswer((_) async => 's-later');
    final ChatBloc bloc = ChatBloc(repo, resumeRedo: store);
    addTearDown(bloc.close);
    bloc.add(const ChatStarted());
    await settle();

    expect(bloc.state.redoSession, isFalse);
  });

  group('isResumeRedoSession — the one rule every road into the form reads',
      () {
    setUp(() async {
      await locator.reset();
      locator.registerSingleton<ChatRepository>(repo);
      locator.registerSingleton<ResumeRedoStore>(store);
    });
    tearDown(() async => locator.reset());

    test('true for the live re-do session', () async {
      await store.markRedo('s-redo');
      when(() => repo.latestSessionId()).thenAnswer((_) async => 's-redo');
      expect(await isResumeRedoSession(), isTrue);
    });

    test('false for any other session', () async {
      await store.markRedo('s-redo');
      when(() => repo.latestSessionId()).thenAnswer((_) async => 's-other');
      expect(await isResumeRedoSession(), isFalse);
    });

    test('false — never a crash — when the read fails', () async {
      await store.markRedo('s-redo');
      when(() => repo.latestSessionId()).thenThrow(Exception('offline'));
      expect(await isResumeRedoSession(), isFalse);
    });

    test('false when the graph does not register the store', () async {
      await locator.reset();
      expect(await isResumeRedoSession(), isFalse);
    });
  });

  group('InMemoryResumeRedoStore', () {
    test('clear forgets the mark', () async {
      await store.markRedo('s-redo');
      await store.clear();
      expect(await store.isRedo('s-redo'), isFalse);
    });

    test('an empty or null id is never a re-do', () async {
      await store.markRedo('');
      expect(await store.isRedo(''), isFalse);
      expect(await store.isRedo(null), isFalse);
    });
  });
}
