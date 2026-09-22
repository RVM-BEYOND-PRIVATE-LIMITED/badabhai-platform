import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_repository.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_session_opening.dart';
import 'package:badabhai_worker_app/features/chat/presentation/bloc/chat_bloc.dart';
import 'package:badabhai_worker_app/features/chat/presentation/chat_profiling_screen.dart';

/// #1660 — an import that yielded NOTHING must not be silent.
///
/// The import read cannot say how much was extracted (backend #1656), so the
/// chat finishes the job with the signal it already has: a staged identity
/// summary opens the session as `resume_pending`. Arriving straight from an
/// import WITHOUT one means the document gave us nothing, and the worker is
/// owed one honest line instead of the ordinary first question as though he had
/// never uploaded.
class _MockChatRepository extends Mock implements ChatRepository {}

const String _kEmptyLine = 'Resume dekh liya';

void main() {
  late _MockChatRepository repo;

  setUp(() async {
    await locator.reset();
    repo = _MockChatRepository();
    locator.registerFactory<ChatBloc>(() => ChatBloc(repo));
  });

  tearDown(() async => locator.reset());

  Future<void> pump(
    WidgetTester tester, {
    required bool fromResumeImport,
    ChatSessionOpening? opening,
  }) async {
    when(() => repo.ensureSession()).thenAnswer((_) async => opening);
    tester.view.physicalSize = const Size(400, 800);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await tester.pumpWidget(
      MaterialApp(
        home: ChatProfilingScreen(fromResumeImport: fromResumeImport),
      ),
    );
    await tester.pump();
    await tester.pumpAndSettle();
  }

  testWidgets('an import with NO staged identity turn says the honest line', (
    WidgetTester tester,
  ) async {
    // The ordinary interview opener — no résumé confirm, so nothing was staged.
    await pump(
      tester,
      fromResumeImport: true,
      opening: const ChatSessionOpening(text: 'Aapka naam kya hai?'),
    );

    expect(find.textContaining(_kEmptyLine), findsOneWidget);
  });

  testWidgets('a productive import stays quiet — the identity turn speaks', (
    WidgetTester tester,
  ) async {
    await pump(
      tester,
      fromResumeImport: true,
      opening: const ChatSessionOpening(
        text: 'Resume se ye mila: CNC Operator, 5 saal. Kya ye aap hi hain?',
        resumePending: true,
      ),
    );

    expect(find.textContaining(_kEmptyLine), findsNothing);
  });

  testWidgets('a worker who never uploaded is never told anything', (
    WidgetTester tester,
  ) async {
    // The "Mere paas resume nahi hai" door, a tab return, a deep link.
    await pump(
      tester,
      fromResumeImport: false,
      opening: const ChatSessionOpening(text: 'Aapka naam kya hai?'),
    );

    expect(find.textContaining(_kEmptyLine), findsNothing);
  });

  testWidgets('it is said once, not on every later turn', (
    WidgetTester tester,
  ) async {
    await pump(
      tester,
      fromResumeImport: true,
      opening: const ChatSessionOpening(text: 'Aapka naam kya hai?'),
    );
    expect(find.textContaining(_kEmptyLine), findsOneWidget);

    // Let the snackbar run out; nothing that happens later may bring it back.
    await tester.pump(const Duration(seconds: 7));
    await tester.pumpAndSettle();
    expect(find.textContaining(_kEmptyLine), findsNothing);
  });
}
