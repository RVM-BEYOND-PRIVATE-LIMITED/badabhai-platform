import 'dart:async' show runZonedGuarded;

import 'package:flutter/gestures.dart' show HitTestEntry, HitTestResult;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_bloc/flutter_bloc.dart' show BlocProvider;
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart'
    show ChatOption, ChatQuestionKind, ResumeHistory, ResumeHistoryItem;
import 'package:badabhai_worker_app/core/config/remote_config.dart';
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/util/pdf_downloader.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_message.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_repository.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_resume_download.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_turn.dart';
import 'package:badabhai_worker_app/features/chat/presentation/bloc/chat_bloc.dart';
import 'package:badabhai_worker_app/features/chat/presentation/chat_profiling_screen.dart';
import 'package:badabhai_worker_app/features/chat/presentation/widgets/chat_resume_download_tile.dart';
import 'package:badabhai_worker_app/features/resume/domain/resume_edit_repository.dart';
import 'package:badabhai_worker_app/features/resume/domain/resume_repository.dart';
import 'package:badabhai_worker_app/features/resume/domain/resume_safe_fields.dart';
import 'package:badabhai_worker_app/features/resume/presentation/resume_pdf_download.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_resume_menu.dart'
    show kResumeMenuTechnicalSkillsKey;
import 'package:badabhai_worker_app/router.dart' show Routes;

class MockChatRepository extends Mock implements ChatRepository {}

class MockResumeRepository extends Mock implements ResumeRepository {}

class MockResumeEditRepository extends Mock implements ResumeEditRepository {}

const String _resumeId = '33333333-3333-4333-8333-333333333333';
const String _recap = 'Namaste. Aapki profile taiyaar hai.';
const String _ask = 'mujhe mera resume download karna hai';

const List<ChatOption> _recapOptions = <ChatOption>[
  ChatOption(optionKey: 'companion_jobs_tab', labelText: 'Sabhi jobs dekhein'),
];

ChatTurn _companion(String reply) => ChatTurn(
  reply: reply,
  followups: <String>[for (final ChatOption o in _recapOptions) o.labelText],
  suggestedOptions: _recapOptions,
  questionKind: ChatQuestionKind.disambiguate,
  companion: true,
  digestKey: 'k1',
);

ResumeHistory _history() => const ResumeHistory(
  items: <ResumeHistoryItem>[
    ResumeHistoryItem(
      resumeId: _resumeId,
      renderStatus: 'rendered',
      isCurrent: true,
    ),
  ],
);

/// Owner ask (2026-10-14) — the Bada Bhai TAB's "Resume download" tile, end to
/// end on the screen: offered on open, put away by the next message, brought
/// back by "resume download karna hai" (which is never posted), and a tap saves
/// the PDF without leaving the chat.
void main() {
  const MethodChannel channel = MethodChannel('badabhai.workerapp/downloads');

  late MockChatRepository repo;
  late MockResumeRepository resumes;
  late List<MethodCall> channelCalls;

  setUp(() async {
    repo = MockChatRepository();
    resumes = MockResumeRepository();
    await locator.reset();
    locator.registerFactory<ChatBloc>(
      () => ChatBloc(repo, resumeRepository: resumes),
    );
    final MockResumeEditRepository edit = MockResumeEditRepository();
    when(() => edit.load()).thenAnswer(
      (_) async => const ResumeSafeFields(
        displayName: 'Ram Kumar',
        showPhoto: false,
        nightShiftReady: false,
      ),
    );
    locator.registerFactory<ResumeEditRepository>(() => edit);

    when(() => repo.loadHistory()).thenAnswer((_) async => const <ChatMessage>[]);
    when(() => repo.ensureSession()).thenAnswer((_) async => null);
    when(() => repo.openCompanion()).thenAnswer(
      (_) async => CompanionOpening(CompanionOpenOutcome.companion, _companion(_recap)),
    );
    when(
      () => repo.sendCompanionMessage(any(), submissionId: any(named: 'submissionId')),
    ).thenAnswer((_) async => _companion('Kisi job par dabakar poori jaankari dekhein.'));
    when(() => resumes.loadResumeHistory()).thenAnswer((_) async => _history());
    when(
      () => resumes.resumeDownloadUrlFor(_resumeId),
    ).thenAnswer((_) async => 'mock://downloads/resume/mock-resume-0001.pdf');
    BbRemoteConfig.instance.debugSetSnapshot(<String, Object>{
      BbRemoteConfig.kKeyChatCompanionEnabled: true,
    });
  });

  tearDown(() async {
    BbRemoteConfig.instance.debugReset();
    await locator.reset();
  });

  Future<void> pumpTab(
    WidgetTester tester, {
    bool assistantTab = true,
    Size logical = const Size(400, 1000),
    double dpr = 1.0,
    double? textScale,
  }) async {
    tester.view.physicalSize = Size(logical.width * dpr, logical.height * dpr);
    tester.view.devicePixelRatio = dpr;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    if (textScale != null) {
      tester.platformDispatcher.textScaleFactorTestValue = textScale;
      addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    }
    channelCalls = <MethodCall>[];
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, (
      MethodCall call,
    ) async {
      channelCalls.add(call);
      if (call.method == 'saveToDownloads') {
        final Map<dynamic, dynamic> args = call.arguments as Map<dynamic, dynamic>;
        return <String, Object>{
          'location': 'content://downloads/7',
          'displayName': args['fileName'] as String,
          'public': true,
        };
      }
      return null;
    });
    addTearDown(
      () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, null),
    );
    await tester.pumpWidget(
      MaterialApp.router(
        routerConfig: GoRouter(
          initialLocation: '/bada-bhai',
          routes: <RouteBase>[
            GoRoute(
              path: '/bada-bhai',
              builder: (_, __) => ChatProfilingScreen(assistantTab: assistantTab),
            ),
            // The chat's section walks push the trade form; Back pops null,
            // saved answers or not.
            GoRoute(
              path: Routes.tradeForm,
              builder: (BuildContext context, __) => Scaffold(
                body: Center(
                  child: TextButton(
                    onPressed: () => context.pop(),
                    child: const Text('SECTION FORM — BACK'),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
    await tester.pump();
    await tester.pumpAndSettle();
  }

  Future<void> send(WidgetTester tester, String text) async {
    await tester.enterText(find.byType(TextField), text);
    await tester.testTextInput.receiveAction(TextInputAction.send);
    await tester.pumpAndSettle();
  }

  final Finder tileButton = find.text(kChatResumeDownloadButtonLabel);

  testWidgets('the tab opens with the "Resume download" tile under the recap', (
    WidgetTester tester,
  ) async {
    await pumpTab(tester);

    expect(find.text(_recap), findsOneWidget);
    expect(find.text(kChatResumeDownloadTileText), findsOneWidget);
    expect(tileButton, findsOneWidget);
  });

  testWidgets('no résumé to download: no tile', (WidgetTester tester) async {
    when(() => resumes.loadResumeHistory()).thenAnswer((_) async => ResumeHistory.empty);
    await pumpTab(tester);

    expect(find.text(_recap), findsOneWidget);
    expect(tileButton, findsNothing);
  });

  testWidgets('the onboarding chat (not the tab) never offers it', (
    WidgetTester tester,
  ) async {
    await pumpTab(tester, assistantTab: false);

    expect(tileButton, findsNothing);
    verifyNever(() => resumes.loadResumeHistory());
  });

  testWidgets(
    'the next message puts the tile away; asking for the résumé brings it back '
    'and posts nothing',
    (WidgetTester tester) async {
      await pumpTab(tester);

      await send(tester, 'naye jobs dikhao');
      expect(tileButton, findsNothing);

      await send(tester, _ask);
      expect(find.text(_ask), findsOneWidget);
      expect(find.text(kChatResumeDownloadReply), findsOneWidget);
      expect(tileButton, findsOneWidget);
      verifyNever(
        () => repo.sendCompanionMessage(_ask, submissionId: any(named: 'submissionId')),
      );
    },
  );

  testWidgets(
    'tapping "Resume download" saves the PDF into Downloads without leaving the chat',
    (WidgetTester tester) async {
      await pumpTab(tester);

      await tester.tap(tileButton);
      await tester.pump();
      await tester.pumpAndSettle();

      expect(find.text(kDownloadCompleteNotice), findsOneWidget);
      verify(() => resumes.resumeDownloadUrlFor(_resumeId)).called(1);
      final MethodCall save = channelCalls.singleWhere(
        (MethodCall c) => c.method == 'saveToDownloads',
      );
      expect(
        (save.arguments as Map<dynamic, dynamic>)['fileName'],
        'RAM_KUMAR_RESUME.pdf',
      );
      // Still on the chat.
      expect(find.text(_recap), findsOneWidget);
    },
  );

  // ── The ask lands where the worker can see it ─────────────────────────────

  const ValueKey<String> buttonKey = ValueKey<String>('chat_resume_download_button');

  /// Whether a tap at the button's centre reaches the button — on screen, not
  /// covered, not scrolled away.
  bool centerHitsButton(WidgetTester tester) {
    final Finder button = find.byKey(buttonKey);
    if (button.evaluate().isEmpty) return false;
    final HitTestResult result = tester.hitTestOnBinding(tester.getCenter(button));
    final RenderObject target = tester.renderObject(button);
    return result.path.any((HitTestEntry e) => e.target == target);
  }

  int saves() =>
      channelCalls.where((MethodCall c) => c.method == 'saveToDownloads').length;

  for (final double scale in <double>[1.0, 1.3]) {
    testWidgets(
      'phone at text x$scale, KEYBOARD UP: a typed ask scrolls its answer and '
      'the tile into view — never just a "Naye message" pill',
      (WidgetTester tester) async {
        await pumpTab(
          tester,
          logical: const Size(360, 640),
          dpr: 2.0,
          textScale: scale,
        );
        for (int i = 0; i < 10; i++) {
          await send(tester, 'naye jobs dikhao $i');
        }
        // The worker taps the composer: the soft keyboard shrinks the list
        // without moving it, leaving it far from the end.
        tester.view.viewInsets = const FakeViewPadding(bottom: 600);
        addTearDown(tester.view.resetViewInsets);
        await tester.pumpAndSettle();

        await send(tester, 'resume download');

        expect(find.text('Naye message'), findsNothing);
        expect(centerHitsButton(tester), isTrue);
        await tester.tap(find.byKey(buttonKey));
        await tester.pump();
        await tester.pumpAndSettle();
        expect(saves(), 1);
        expect(find.text(kDownloadCompleteNotice), findsOneWidget);
      },
    );
  }

  testWidgets(
    'after the recap REPLACES an interview transcript, a typed ask (keyboard up) '
    'still scrolls its answer and the tile into view',
    (WidgetTester tester) async {
      final String longRecap = <String>[
        'Namaste. Aapki profile taiyaar hai.',
        for (int i = 1; i <= 14; i++) 'Aapki jaankari ki line $i yahan hai.',
      ].join('\n');
      // The recap is drawn as bullet lines, so it is found by one of them.
      final Finder recapLine = find.textContaining(
        'Aapki jaankari ki line 14',
        findRichText: true,
      );
      // The tab opened on the INTERVIEW: a finished transcript of 21 bubbles.
      when(() => repo.openCompanion()).thenAnswer((_) async => const CompanionOpening.interview());
      when(() => repo.loadHistory()).thenAnswer(
        (_) async => <ChatMessage>[
          for (int i = 0; i < 21; i++)
            ChatMessage(text: 'purani baat $i', fromWorker: i.isOdd),
        ],
      );
      when(() => repo.forgetSession()).thenReturn(null);
      await pumpTab(tester, logical: const Size(360, 640), dpr: 2.0);
      expect(recapLine, findsNothing);

      // The server now answers companion: the recap REPLACES the transcript.
      when(() => repo.openCompanion()).thenAnswer(
        (_) async => CompanionOpening(CompanionOpenOutcome.companion, _companion(longRecap)),
      );
      BlocProvider.of<ChatBloc>(
        tester.element(find.byType(TextField)),
      ).add(const ChatCompanionRefreshRequested());
      await tester.pumpAndSettle();
      expect(recapLine, findsWidgets);

      tester.view.viewInsets = const FakeViewPadding(bottom: 600);
      addTearDown(tester.view.resetViewInsets);
      await tester.pumpAndSettle();
      await send(tester, 'resume download');

      expect(find.text('Naye message'), findsNothing);
      expect(centerHitsButton(tester), isTrue);
    },
  );

  // ── Honest waits on the tile (G4) ─────────────────────────────────────────

  testWidgets(
    'a PDF that FAILED after the tile was offered says so at the first tap — '
    'no 75s of "PDF taiyaar ho rahi hai…"',
    (WidgetTester tester) async {
      int mints = 0;
      when(() => resumes.resumeDownloadUrlFor(_resumeId)).thenAnswer((_) async {
        mints++;
        throw const ResumePdfUnavailableFailure();
      });
      await pumpTab(tester);

      await tester.tap(tileButton);
      await tester.pump();
      await tester.pump();
      await tester.pump(const Duration(seconds: 1));

      expect(find.text(kResumePdfUnavailableMessage), findsOneWidget);
      expect(find.text(kResumePreparingLabel), findsNothing);
      expect(mints, 1);
      expect(saves(), 0);
      await tester.pumpAndSettle();
    },
  );

  testWidgets(
    'a render that fails DURING the wait ends it with the honest reason, '
    'after one mint',
    (WidgetTester tester) async {
      int reads = 0;
      when(() => resumes.loadResumeHistory()).thenAnswer((_) async {
        reads++;
        // The open's read offers it still rendering; then the render fails.
        return reads == 1 ? _historyAt('pending') : _historyAt('failed');
      });
      int mints = 0;
      when(() => resumes.resumeDownloadUrlFor(_resumeId)).thenAnswer((_) async {
        mints++;
        throw const ResumeNotReadyFailure();
      });
      await pumpTab(tester);

      await tester.tap(tileButton);
      await tester.pump();
      await tester.pump();
      for (int i = 0; i < 3; i++) {
        await tester.pump(const Duration(milliseconds: 1500));
      }

      expect(find.text(kResumePdfUnavailableMessage), findsOneWidget);
      expect(mints, 1);
      expect(saves(), 0);
      await tester.pumpAndSettle();
      // ...and the tile goes: the history now says failed, and a button whose
      // every tap would meet the same 409 is not left on screen.
      expect(find.byKey(buttonKey), findsNothing);
    },
  );

  testWidgets(
    'a still-rendering PDF is waited out on the history read and saved when it '
    'lands — TWO mints, not one every 1.5s (each is charged to the server\'s '
    'per-IP download cap)',
    (WidgetTester tester) async {
      int reads = 0;
      when(() => resumes.loadResumeHistory()).thenAnswer((_) async {
        reads++;
        // The open's read and two waits see it rendering; then it lands.
        return reads <= 3 ? _historyAt('pending') : _historyAt('rendered');
      });
      int mints = 0;
      when(() => resumes.resumeDownloadUrlFor(_resumeId)).thenAnswer((_) async {
        mints++;
        // The server's own rule: no PDF to sign until the render lands — which
        // only the history reads above can see. A wait that re-minted instead
        // of reading would meet this 409 on every one of its mints.
        if (reads <= 3) throw const ResumeNotReadyFailure();
        return 'mock://downloads/resume/mock-resume-0001.pdf';
      });
      await pumpTab(tester);

      await tester.tap(tileButton);
      await tester.pump();
      await tester.pump();
      expect(find.text(kResumePreparingLabel), findsOneWidget);
      for (int i = 0; i < 6; i++) {
        await tester.pump(const Duration(milliseconds: 1500));
      }
      await tester.pumpAndSettle();

      expect(mints, 2);
      expect(saves(), 1);
      expect(find.text(kDownloadCompleteNotice), findsOneWidget);
    },
  );

  testWidgets(
    'the tile releases its busy latch however a download ends — even one that '
    'throws leaves a button that answers the next tap',
    (WidgetTester tester) async {
      int downloads = 0;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: ChatResumeDownloadTile(
              mintUrl: () async => 'mock://x',
              loadFileName: () async => 'X_RESUME.pdf',
              download: (
                BuildContext context, {
                required Future<String?> Function() resolve,
                required String fileName,
              }) async {
                downloads++;
                throw StateError('boom');
              },
            ),
          ),
        ),
      );
      final List<Object> errors = <Object>[];
      Future<void> tapGuarded() => runZonedGuarded<Future<void>>(
        () async {
          await tester.tap(find.byKey(buttonKey));
          await tester.pump();
          await tester.pump();
        },
        (Object error, StackTrace _) => errors.add(error),
      )!;

      await tapGuarded();
      await tapGuarded();

      expect(downloads, 2);
      expect(errors, hasLength(2));
      expect(errors.every((Object e) => e is StateError), isTrue);
    },
  );

  // ── Case 2 after a section walk (G2) ──────────────────────────────────────

  testWidgets(
    'a section walk backed out of (it pops null, saved or not) still offers the '
    're-rendered résumé when the render lands — the worker never leaves the chat',
    (WidgetTester tester) async {
      ChatBloc.resumeChangeWatchInterval = const Duration(seconds: 1);
      addTearDown(() => ChatBloc.resumeChangeWatchInterval = const Duration(seconds: 4));
      final DateTime made = DateTime.utc(2026, 10, 14, 9);
      ResumeHistory version(DateTime renderedAt) => ResumeHistory(
        items: <ResumeHistoryItem>[
          ResumeHistoryItem(
            resumeId: _resumeId,
            renderStatus: 'rendered',
            isCurrent: true,
            generatedAt: made,
            renderedAt: renderedAt,
          ),
        ],
      );
      ResumeHistory current = version(DateTime.utc(2026, 10, 14, 9, 1));
      when(() => resumes.loadResumeHistory()).thenAnswer((_) async => current);
      const ChatOption skills = ChatOption(
        optionKey: kResumeMenuTechnicalSkillsKey,
        labelText: 'Technical Skills',
      );
      when(
        () => repo.sendCompanionMessage('resume badalna hai', submissionId: any(named: 'submissionId')),
      ).thenAnswer(
        (_) async => const ChatTurn(
          reply: 'Resume ka kaun sa hissa theek karna hai.',
          followups: <String>['Technical Skills'],
          suggestedOptions: <ChatOption>[skills],
          questionKind: ChatQuestionKind.disambiguate,
          companion: true,
        ),
      );
      await pumpTab(tester);
      expect(tileButton, findsOneWidget, reason: 'case 1 on the first open');

      await send(tester, 'resume badalna hai');
      expect(tileButton, findsNothing);
      await tester.tap(find.text('Technical Skills'));
      await tester.pumpAndSettle();
      // The worker answers a page (its save queues a re-render a minute out on
      // the server) and backs out.
      await tester.tap(find.text('SECTION FORM — BACK'));
      await tester.pumpAndSettle();
      expect(tileButton, findsNothing, reason: 'the old render is still current');

      // The re-render lands while the worker stays on the chat.
      current = version(DateTime.utc(2026, 10, 15, 10));
      await tester.pump(const Duration(seconds: 2));
      await tester.pumpAndSettle();

      expect(tileButton, findsOneWidget);
    },
  );
}

ResumeHistory _historyAt(String renderStatus) => ResumeHistory(
  items: <ResumeHistoryItem>[
    ResumeHistoryItem(
      resumeId: _resumeId,
      renderStatus: renderStatus,
      isCurrent: true,
    ),
  ],
);
