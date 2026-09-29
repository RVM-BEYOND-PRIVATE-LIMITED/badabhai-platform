import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart'
    show ChatOption, ChatQuestionKind, EditProposal, EditProposalRow;
import 'package:badabhai_worker_app/core/config/remote_config.dart';
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_companion_keys.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_message.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_repository.dart';
import 'package:badabhai_worker_app/core/nav/tab_focus.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_turn.dart';
import 'package:badabhai_worker_app/features/chat/presentation/bloc/chat_bloc.dart';
import 'package:badabhai_worker_app/features/chat/presentation/chat_profiling_screen.dart';
import 'package:badabhai_worker_app/core/widgets/onboarding/primary_action_button.dart';
import 'package:badabhai_worker_app/features/voice_form/presentation/widgets/voice_choice_chips.dart'
    show kVoiceBooleanNo, kVoiceBooleanYes;
import 'package:badabhai_worker_app/features/swipe/domain/job_detail.dart';
import 'package:badabhai_worker_app/router.dart';

/// ── THE BADA BHAI TAB IN COMPANION MODE (ADR-0044) ──────────────────────────
///
/// Only the `/bada-bhai` tab, only with the Remote Config switch on, asks for
/// the companion. Its chips route on `option_key`:
///   - `companion_job:<id>` opens that job's detail, never posted;
///   - `companion_jobs_tab` switches to the Jobs tab, never posted;
///   - `companion_applied` opens the applied list, never posted;
///   - `companion_resume` / `companion_new_jobs` are answered by the server.
/// The "build my profile" CTA is gone: the profile is already done.
class MockChatRepository extends Mock implements ChatRepository {}

const String _jobId = '11111111-1111-4111-8111-111111111111';
const String _recap = 'Namaste. Aapki profile taiyaar hai. Ab tak yeh hua hai.';

const List<ChatOption> _recapOptions = <ChatOption>[
  ChatOption(optionKey: 'companion_job:$_jobId', labelText: 'CNC Operator — Pune'),
  ChatOption(optionKey: 'companion_jobs_tab', labelText: 'Sabhi jobs dekhein'),
  ChatOption(optionKey: 'companion_applied', labelText: 'Apni applications dekhein'),
  ChatOption(optionKey: 'companion_resume', labelText: 'Resume badlein'),
];

ChatTurn _companion(String reply, List<ChatOption> options) => ChatTurn(
      reply: reply,
      followups: <String>[for (final ChatOption o in options) o.labelText],
      suggestedOptions: options,
      questionKind: ChatQuestionKind.disambiguate,
      companion: true,
      digestKey: 'k1',
    );

void main() {
  late MockChatRepository repo;

  setUp(() async {
    repo = MockChatRepository();
    await locator.reset();
    locator.registerFactory<ChatBloc>(() => ChatBloc(repo));
    when(() => repo.loadHistory()).thenAnswer((_) async => const <ChatMessage>[]);
    when(() => repo.ensureSession()).thenAnswer((_) async => null);
    when(() => repo.openCompanion()).thenAnswer((_) async => CompanionOpening(CompanionOpenOutcome.companion, _companion(_recap, _recapOptions)));
  });

  tearDown(() async {
    BbRemoteConfig.instance.debugReset();
    await locator.reset();
  });

  void companionSwitch(bool on) => BbRemoteConfig.instance
      .debugSetSnapshot(<String, Object>{
        BbRemoteConfig.kKeyChatCompanionEnabled: on,
        // ADR-0046 F4 — the v2 UI (edit card, task chips' rendering, voice
        // button) rides its own lever; every companion test here that wants the
        // card turns both on, exactly as the console would.
        BbRemoteConfig.kKeyChatCompanionV2Enabled: on,
      });

  GoRouter router({bool assistantTab = true}) => GoRouter(
        initialLocation: '/bada-bhai',
        routes: <RouteBase>[
          GoRoute(
            path: '/bada-bhai',
            builder: (_, __) => ChatProfilingScreen(assistantTab: assistantTab),
          ),
          GoRoute(
            path: '${Routes.jobDetail}/:jobId',
            builder: (_, GoRouterState s) {
              final JobDetail d = s.extra! as JobDetail;
              return Scaffold(
                body: Center(
                  child: Text('DETAIL ${s.pathParameters['jobId']} | ${d.title} | ${d.city}'),
                ),
              );
            },
          ),
          GoRoute(
            path: Routes.jobs,
            builder: (_, __) => const Scaffold(body: Center(child: Text('JOBS TAB'))),
          ),
          GoRoute(
            path: Routes.appliedJobs,
            builder: (_, __) => const Scaffold(body: Center(child: Text('APPLIED LIST'))),
          ),
          // ADR-0046 F3 — a stand-in for the voice screen. The real one records
          // and transcribes; this proves the chat opens it in COMPOSE mode
          // (`extra: true`) and lands the popped transcript in the composer.
          GoRoute(
            path: Routes.voiceNote,
            builder: (BuildContext context, GoRouterState s) => Scaffold(
              body: Center(
                child: TextButton(
                  onPressed: () =>
                      context.pop(s.extra == true ? 'boli hui baat' : null),
                  child: Text(s.extra == true ? 'COMPOSE VOICE' : 'SEND VOICE'),
                ),
              ),
            ),
          ),
        ],
      );

  Future<void> pumpTab(WidgetTester tester, {bool assistantTab = true}) async {
    tester.view.physicalSize = const Size(400, 1000);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(MaterialApp.router(routerConfig: router(assistantTab: assistantTab)));
    await tester.pump();
    await tester.pumpAndSettle();
  }

  testWidgets('switch ON: the tab opens on the recap, touches no session, and has no "build my profile" CTA',
      (WidgetTester tester) async {
    companionSwitch(true);
    await pumpTab(tester);

    expect(find.text(_recap), findsOneWidget);
    expect(find.text('CNC Operator — Pune'), findsOneWidget);
    expect(find.text(kChatDoneNotReadyLabel), findsNothing);
    verify(() => repo.openCompanion()).called(1);
    verifyNever(() => repo.ensureSession());
  });

  testWidgets('a job chip opens THAT job\'s detail with its title and city, and posts nothing',
      (WidgetTester tester) async {
    companionSwitch(true);
    await pumpTab(tester);

    await tester.tap(find.text('CNC Operator — Pune'));
    await tester.pumpAndSettle();

    expect(find.text('DETAIL $_jobId | CNC Operator | Pune'), findsOneWidget);
    verifyNever(() => repo.sendCompanionMessage(any(), submissionId: any(named: 'submissionId')));
    verifyNever(() => repo.sendMessage(any(), submissionId: any(named: 'submissionId')));
  });

  testWidgets('"Sabhi jobs dekhein" switches to the Jobs tab, and posts nothing', (WidgetTester tester) async {
    companionSwitch(true);
    await pumpTab(tester);

    await tester.tap(find.text('Sabhi jobs dekhein'));
    await tester.pumpAndSettle();

    expect(find.text('JOBS TAB'), findsOneWidget);
    verifyNever(() => repo.sendCompanionMessage(any(), submissionId: any(named: 'submissionId')));
  });

  testWidgets('"Apni applications dekhein" opens the applied list, and posts nothing',
      (WidgetTester tester) async {
    companionSwitch(true);
    await pumpTab(tester);

    await tester.tap(find.text('Apni applications dekhein'));
    await tester.pumpAndSettle();

    expect(find.text('APPLIED LIST'), findsOneWidget);
    verifyNever(() => repo.sendCompanionMessage(any(), submissionId: any(named: 'submissionId')));
  });

  testWidgets('"Resume badlein" is answered by the server, through the COMPANION route',
      (WidgetTester tester) async {
    companionSwitch(true);
    when(() => repo.sendCompanionMessage(any(), submissionId: any(named: 'submissionId'))).thenAnswer(
      (_) async => _companion('Aap kya karna chahte hain. Neeche se chunein.', const <ChatOption>[
        ChatOption(optionKey: 'resume_edit', labelText: 'Apna resume edit karein'),
        ChatOption(optionKey: 'resume_redo', labelText: 'Apna resume dobara banayein'),
      ]),
    );
    await pumpTab(tester);

    await tester.tap(find.text('Resume badlein'));
    await tester.pumpAndSettle();

    verify(() => repo.sendCompanionMessage('Resume badlein', submissionId: any(named: 'submissionId')))
        .called(1);
    verifyNever(() => repo.sendMessage(any(), submissionId: any(named: 'submissionId')));
    expect(find.text('Apna resume edit karein'), findsOneWidget);
  });

  testWidgets('switch OFF (the default): today\'s tab — no companion call, the session opens, the CTA is there',
      (WidgetTester tester) async {
    await pumpTab(tester);

    verifyNever(() => repo.openCompanion());
    verify(() => repo.ensureSession()).called(1);
    expect(find.text(kChatDoneNotReadyLabel), findsOneWidget);
  });

  testWidgets('switch ON but not the Bada Bhai tab (the /chat route): today\'s chat, no companion call',
      (WidgetTester tester) async {
    companionSwitch(true);
    await pumpTab(tester, assistantTab: false);

    verifyNever(() => repo.openCompanion());
    verify(() => repo.ensureSession()).called(1);
  });

  testWidgets('not a companion worker (null): today\'s tab, CTA included', (WidgetTester tester) async {
    companionSwitch(true);
    when(() => repo.openCompanion())
          .thenAnswer((_) async => const CompanionOpening.interview());
    await pumpTab(tester);

    verify(() => repo.ensureSession()).called(1);
    expect(find.text(_recap), findsNothing);
    expect(find.text(kChatDoneNotReadyLabel), findsOneWidget);
  });

  // ── #1755.1 — THE REFOCUS TRIGGER, through the real wrapper ────────────────
  // Every other test leaves `TabFocus` unregistered, so `_CompanionRefocus`
  // takes its bail-out and renders the bare child: a wrong tab index, a dropped
  // wrapper or a bloc read from above its provider would all pass unnoticed.
  testWidgets('a tab refocus re-reads the recap through TabFocusRefetch',
      (WidgetTester tester) async {
    companionSwitch(true);
    DateTime now = DateTime.utc(2026, 9, 26, 10);
    final TabFocus focus = TabFocus(TabIndex.chat);
    locator
      ..unregister<ChatBloc>()
      ..registerFactory<ChatBloc>(() => ChatBloc(repo, clock: () => now))
      ..registerLazySingleton<TabFocus>(() => focus);

    await pumpTab(tester);
    verify(() => repo.openCompanion()).called(1);

    // Away and back, past the throttle.
    focus.value = TabIndex.jobs;
    await tester.pump();
    now = now.add(const Duration(seconds: 61));
    focus.value = TabIndex.chat;
    await tester.pump();
    await tester.pumpAndSettle();

    verify(() => repo.openCompanion()).called(1);
  });

  // ── THE SWITCH LANDED AFTER THE TAB OPENED ──────────────────────────────────
  // Remote Config is fetched after the first frame, so a tab opened early reads
  // the compiled-in "off". The wrapper used to exist only when the switch was on
  // at mount, so such a tab never asked for the recap until the app was killed.
  // It now reads the switch on every refocus.
  group('a tab that opened with the switch OFF', () {
    late TabFocus focus;

    Future<void> pumpWithFocus(WidgetTester tester) async {
      focus = TabFocus(TabIndex.chat);
      locator.registerLazySingleton<TabFocus>(() => focus);
      await pumpTab(tester);
      verifyNever(() => repo.openCompanion());
      expect(find.text(kChatDoneNotReadyLabel), findsOneWidget);
    }

    Future<void> awayAndBack(WidgetTester tester) async {
      focus.value = TabIndex.jobs;
      await tester.pump();
      focus.value = TabIndex.chat;
      await tester.pump();
      await tester.pumpAndSettle();
    }

    testWidgets('moves to the recap on a refocus once the switch is on', (WidgetTester tester) async {
      await pumpWithFocus(tester);

      companionSwitch(true);
      await awayAndBack(tester);

      verify(() => repo.openCompanion()).called(1);
      expect(find.text(_recap), findsOneWidget);
      expect(find.text(kChatDoneNotReadyLabel), findsNothing);
      expect(find.text(kChatDoneReadyLabel), findsNothing);
    });

    testWidgets('asks nothing on a refocus while the switch is still off', (WidgetTester tester) async {
      await pumpWithFocus(tester);

      await awayAndBack(tester);

      verifyNever(() => repo.openCompanion());
      expect(find.text(kChatDoneNotReadyLabel), findsOneWidget);
    });
  });

  // ── #1755.3 — the recap on the smallest supported screen, at 2.0 text ──────
  testWidgets('the recap and its chips fit at 320x568, text scale 2.0',
      (WidgetTester tester) async {
    companionSwitch(true);
    tester.view.physicalSize = const Size(320, 568);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await tester.pumpWidget(
      MediaQuery(
        data: const MediaQueryData(textScaler: TextScaler.linear(2.0)),
        child: MaterialApp.router(routerConfig: router()),
      ),
    );
    await tester.pump();
    await tester.pumpAndSettle();

    // No overflow, and a chip is really on screen — not painted past the edge.
    expect(tester.takeException(), isNull);
    final Finder chip = find.text('Sabhi jobs dekhein');
    expect(chip, findsOneWidget);
    final Rect box = tester.getRect(chip);
    expect(box.left, greaterThanOrEqualTo(0));
    expect(box.right, lessThanOrEqualTo(320));
  });

  // ── #1752 — the chip goes, and he is told the apply landed ─────────────────
  testWidgets('applying through a job chip drops that chip and confirms',
      (WidgetTester tester) async {
    companionSwitch(true);
    await pumpTab(tester);
    expect(find.text('CNC Operator — Pune'), findsOneWidget);

    await tester.tap(find.text('CNC Operator — Pune'));
    await tester.pumpAndSettle();
    expect(find.textContaining('DETAIL $_jobId'), findsOneWidget);

    // Job detail pops 'applied', exactly as JobDetailScreen does.
    final NavigatorState nav = tester.state<NavigatorState>(find.byType(Navigator).last);
    nav.pop('applied');
    await tester.pumpAndSettle();

    expect(find.text(kCompanionAppliedToast), findsOneWidget);
    // The chip is gone: tapping it again would reopen the detail with
    // "Apply karein" for a job he has already applied to.
    expect(find.text('CNC Operator — Pune'), findsNothing);
    // The other chips are untouched.
    expect(find.text('Sabhi jobs dekhein'), findsOneWidget);
  });

  // ── #1754 — the chips announce as BUTTONS, not as an unchecked radio group ─
  testWidgets('a companion chip is a button, with no checked state',
      (WidgetTester tester) async {
    companionSwitch(true);
    final SemanticsHandle handle = tester.ensureSemantics();
    await pumpTab(tester);

    expect(
      tester.getSemantics(find.text('Sabhi jobs dekhein')),
      matchesSemantics(
        label: 'Sabhi jobs dekhein',
        isButton: true,
        hasTapAction: true,
        hasFocusAction: true,
        isFocusable: true,
        // The point of #1754: no radio state, and no group to be one of.
        hasCheckedState: false,
        isInMutuallyExclusiveGroup: false,
      ),
    );
    handle.dispose();
  });

  // ── ADR-0046 §5.1/§5.2 — THE EDIT CARD ─────────────────────────────────────
  //
  // The card shows one row per proposed change (all ticked), Haan / Nahi, and
  // disables after `expires_at`. Haan POSTs the ticked rows' server-minted ids
  // to the confirm route; Nahi POSTs the cancel route. The VALUES never leave.
  group('ADR-0046 edit card', () {
    const String proposalId = '22222222-2222-4222-8222-222222222222';
    const String rowA = '33333333-3333-4333-8333-333333333333';
    const String rowB = '44444444-4444-4444-8444-444444444444';

    EditProposal proposal({Duration ttl = const Duration(minutes: 10)}) =>
        EditProposal(
          proposalId: proposalId,
          expiresAt: DateTime.now().add(ttl),
          rows: const <EditProposalRow>[
            EditProposalRow(
              rowId: rowA,
              sectionLabel: 'Skills',
              op: 'add',
              after: 'Welding',
            ),
            EditProposalRow(
              rowId: rowB,
              sectionLabel: 'Languages',
              op: 'delete',
              before: 'Hindi',
            ),
          ],
        );

    Future<void> pumpWithCard(
      WidgetTester tester, {
      Duration ttl = const Duration(minutes: 10),
    }) async {
      companionSwitch(true);
      when(() => repo.sendCompanionMessage(any(),
              submissionId: any(named: 'submissionId')))
          .thenAnswer((_) async => ChatTurn(
                reply: 'Yeh badlav karne hain?',
                followups: const <String>[],
                suggestedOptions: const <ChatOption>[],
                questionKind: ChatQuestionKind.disambiguate,
                companion: true,
                editProposal: proposal(ttl: ttl),
              ));
      await pumpTab(tester);
      // The card arrives on a MESSAGE answer (the open serves the recap): the
      // v1 "Resume badlein" chip is server-answered, so tapping it POSTs.
      await tester.tap(find.text('Resume badlein'));
      await tester.pumpAndSettle();
    }

    testWidgets('renders every row ticked, with Haan / Nahi',
        (WidgetTester tester) async {
      await pumpWithCard(tester);

      expect(find.text('Skills'), findsOneWidget);
      expect(find.text('Languages'), findsOneWidget);
      // EVERY ROW SAYS WHAT IT DOES. `section_label` names the section only, so
      // "Welding" under "Skills" could equally mean adding or removing it — and
      // a delete row used to be carried by a strikethrough alone, on a card
      // where every row arrives pre-ticked. A worker tapping Haan without
      // decoding that lost a skill off their own résumé.
      expect(find.textContaining('$kEditOpAdd Welding'), findsOneWidget);
      expect(find.textContaining('$kEditOpDelete Hindi'), findsOneWidget);

      final Iterable<Checkbox> boxes =
          tester.widgetList<Checkbox>(find.byType(Checkbox));
      expect(boxes, hasLength(2));
      expect(boxes.every((Checkbox c) => c.value == true), isTrue);

      expect(find.text(kVoiceBooleanYes), findsOneWidget);
      expect(find.text(kVoiceBooleanNo), findsOneWidget);
    });

    testWidgets('Haan confirms with EVERY ticked row id', (WidgetTester tester) async {
      when(() => repo.confirmCompanionEdit(any(), any(),
              submissionId: any(named: 'submissionId')))
          .thenAnswer((_) async => CompanionEditResult.served(
                _companion('Badlav ho gaya.', const <ChatOption>[]),
              ));
      await pumpWithCard(tester);

      await tester.tap(find.text(kVoiceBooleanYes));
      await tester.pumpAndSettle();

      verify(() => repo.confirmCompanionEdit(proposalId, <String>[rowA, rowB],
          submissionId: any(named: 'submissionId'))).called(1);
      // The served turn replaced the card with its reply bubble.
      expect(find.text('Badlav ho gaya.'), findsOneWidget);
      expect(find.byType(Checkbox), findsNothing);
    });

    testWidgets('an UNTICKED row is not sent', (WidgetTester tester) async {
      when(() => repo.confirmCompanionEdit(any(), any(),
              submissionId: any(named: 'submissionId')))
          .thenAnswer((_) async => CompanionEditResult.served(
                _companion('Badlav ho gaya.', const <ChatOption>[]),
              ));
      await pumpWithCard(tester);

      // Tapping the row (its label) unticks it.
      await tester.tap(find.text('Skills'));
      await tester.pumpAndSettle();

      await tester.tap(find.text(kVoiceBooleanYes));
      await tester.pumpAndSettle();

      verify(() => repo.confirmCompanionEdit(proposalId, <String>[rowB],
          submissionId: any(named: 'submissionId'))).called(1);
    });

    testWidgets('Nahi cancels and renders the server turn', (WidgetTester tester) async {
      when(() => repo.cancelCompanionEdit(any(),
              submissionId: any(named: 'submissionId')))
          .thenAnswer((_) async => CompanionEditResult.served(
                _companion('Theek hai, kuch nahi badla.', const <ChatOption>[]),
              ));
      await pumpWithCard(tester);

      await tester.tap(find.text(kVoiceBooleanNo));
      await tester.pumpAndSettle();

      verify(() => repo.cancelCompanionEdit(proposalId,
          submissionId: any(named: 'submissionId'))).called(1);
      expect(find.text('Theek hai, kuch nahi badla.'), findsOneWidget);
    });

    testWidgets('an EXPIRED card disables Haan and Nahi', (WidgetTester tester) async {
      await pumpWithCard(tester, ttl: const Duration(seconds: -1));

      final Finder haan = find.widgetWithText(PrimaryActionButton, kVoiceBooleanYes);
      expect(tester.widget<PrimaryActionButton>(haan).onPressed, isNull);
      final Finder nahi = find.widgetWithText(OutlinedButton, kVoiceBooleanNo);
      expect(tester.widget<OutlinedButton>(nahi).onPressed, isNull);
    });

    // ADR-0046 F4 — the v2 UI rides its OWN lever. A companion worker whose
    // phone has not flipped `worker_chat_companion_v2_enabled` must see Phase 1
    // only: the reply renders, the card does not.
    testWidgets('the v2 lever OFF hides the card (F4)',
        (WidgetTester tester) async {
      BbRemoteConfig.instance.debugSetSnapshot(<String, Object>{
        BbRemoteConfig.kKeyChatCompanionEnabled: true,
        BbRemoteConfig.kKeyChatCompanionV2Enabled: false,
      });
      when(() => repo.sendCompanionMessage(any(),
              submissionId: any(named: 'submissionId')))
          .thenAnswer((_) async => ChatTurn(
                reply: 'Yeh badlav karne hain?',
                followups: const <String>[],
                suggestedOptions: const <ChatOption>[],
                questionKind: ChatQuestionKind.disambiguate,
                companion: true,
                editProposal: proposal(),
              ));
      await pumpTab(tester);
      await tester.tap(find.text('Resume badlein'));
      await tester.pumpAndSettle();

      expect(find.text('Yeh badlav karne hain?'), findsOneWidget);
      expect(find.text('Skills'), findsNothing);
      expect(find.byType(Checkbox), findsNothing);
    });
  });

  // ── ADR-0046 F2 — THE TASK CHIPS ARE POSTED ────────────────────────────────
  //
  // A task chip is server-answered: the app sends the chip's LABEL as ordinary
  // text and the classifier routes it (contracts §5.3). Nothing about it may
  // resolve to a client route — the test router has no resume-edit route, so a
  // client-side route would throw instead of POSTing.
  testWidgets('a task chip POSTS its label as text', (WidgetTester tester) async {
    companionSwitch(true);
    when(() => repo.openCompanion()).thenAnswer(
      (_) async => CompanionOpening(
        CompanionOpenOutcome.companion,
        const ChatTurn(
          reply: _recap,
          followups: <String>['Resume badlo'],
          suggestedOptions: <ChatOption>[
            ChatOption(
              optionKey: kCompanionTaskEditResumeKey,
              labelText: 'Resume badlo',
            ),
          ],
          questionKind: ChatQuestionKind.disambiguate,
          companion: true,
          digestKey: 'k1',
        ),
      ),
    );
    when(() => repo.sendCompanionMessage(any(),
            submissionId: any(named: 'submissionId')))
        .thenAnswer((_) async => _companion('Theek hai.', const <ChatOption>[]));
    await pumpTab(tester);

    await tester.tap(find.text('Resume badlo'));
    await tester.pumpAndSettle();

    verify(() => repo.sendCompanionMessage('Resume badlo',
        submissionId: any(named: 'submissionId'))).called(1);
  });

  // ── ADR-0046 F1 — THE CARD EXPIRES WHILE THE WORKER IS LOOKING AT IT ───────
  //
  // `expires_at` is the proposal's Redis TTL, mirrored so the app can disable
  // Haan/Nahi without a round-trip. A card that only re-read the clock on some
  // OTHER rebuild would sit there enabled indefinitely on a screen where
  // nothing else moves — so the card runs its own one-second ticker, and this
  // is what proves the ticker is wired rather than decorative.
  testWidgets('Haan and Nahi disable themselves when expires_at passes',
      (WidgetTester tester) async {
    companionSwitch(true);
    when(() => repo.openCompanion()).thenAnswer(
      (_) async => CompanionOpening(
        CompanionOpenOutcome.companion,
        ChatTurn(
          reply: _recap,
          companion: true,
          digestKey: 'k1',
          editProposal: EditProposal(
            proposalId: 'p-expiry',
            // Short, because the card reads the REAL clock: only real elapsed
            // time can expire it (see the pump below).
            expiresAt: DateTime.now().add(const Duration(milliseconds: 400)),
            rows: const <EditProposalRow>[
              EditProposalRow(
                rowId: 'r1',
                sectionLabel: 'Skills',
                op: 'add',
                after: 'Welding',
              ),
            ],
          ),
        ),
      ),
    );
    await pumpTab(tester);

    // Live: the card is drawn and both answers are offered.
    expect(find.text('Skills'), findsOneWidget);
    final Finder haan = find.widgetWithText(PrimaryActionButton, kVoiceBooleanYes);
    expect(haan, findsOneWidget);
    expect(tester.widget<PrimaryActionButton>(haan).onPressed, isNotNull,
        reason: 'a live card must offer Haan');

    // Cross the TTL with NO other state change whatsoever — only the card's own
    // ticker can notice. `runAsync` because `_expired` compares against the real
    // `DateTime.now()`, which `pump`'s fake clock does not move; the pump after
    // it is what lets the periodic timer fire its setState.
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 700)),
    );
    await tester.pump(const Duration(seconds: 1));

    expect(tester.widget<PrimaryActionButton>(haan).onPressed, isNull,
        reason: 'the ticker never fired — Haan would POST a dead proposal');
    // And it says so, rather than leaving a dead button unexplained.
    expect(find.text('Ye prastav ki samay-seema khatam ho gayi.'), findsOneWidget);
  });

  // ── #1821 F1 — THE COOL-DOWN BLOCKS FREE TEXT, AND ONLY FREE TEXT ──────────
  testWidgets('a cool-down turn locks the composer with a countdown, and the CHIPS stay tappable',
      (WidgetTester tester) async {
    companionSwitch(true);
    when(() => repo.openCompanion()).thenAnswer(
      (_) async => CompanionOpening(
        CompanionOpenOutcome.companion,
        ChatTurn(
          reply: 'Thodi der ruk jaayein.',
          followups: const <String>['Naya resume'],
          suggestedOptions: const <ChatOption>[
            ChatOption(
              optionKey: kCompanionTaskNewResumeKey,
              labelText: 'Naya resume',
            ),
          ],
          questionKind: ChatQuestionKind.disambiguate,
          companion: true,
          digestKey: 'k1',
          cooldownUntil: DateTime.now().add(const Duration(minutes: 2)),
        ),
      ),
    );
    when(() => repo.sendCompanionMessage(any(),
            submissionId: any(named: 'submissionId')))
        .thenAnswer((_) async => _companion('Theek hai.', const <ChatOption>[]));
    await pumpTab(tester);

    // Free text is gone — a visible-but-ignored box is what makes a worker type
    // into nothing.
    expect(find.byType(TextField), findsNothing);
    // And the bar says HOW LONG, not just "later" — the number is the point.
    expect(find.textContaining('minute baad likh sakte hain'), findsOneWidget);
    expect(find.textContaining('vyast'), findsOneWidget);

    // THE CHIPS STILL WORK. A cooled-down worker must still reach their résumé.
    await tester.tap(find.text('Naya resume'));
    await tester.pumpAndSettle();
    verify(() => repo.sendCompanionMessage('Naya resume',
        submissionId: any(named: 'submissionId'))).called(1);
  });

  testWidgets('the composer comes back on its own when the cool-down passes',
      (WidgetTester tester) async {
    companionSwitch(true);
    when(() => repo.openCompanion()).thenAnswer(
      (_) async => CompanionOpening(
        CompanionOpenOutcome.companion,
        ChatTurn(
          reply: 'Thodi der ruk jaayein.',
          companion: true,
          digestKey: 'k1',
          // Short, because the lock reads the REAL clock.
          cooldownUntil: DateTime.now().add(const Duration(milliseconds: 400)),
        ),
      ),
    );
    await pumpTab(tester);
    expect(find.byType(TextField), findsNothing, reason: 'locked while cooling');

    // Only the lock's own ticker can notice; nothing else on this screen moves.
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 700)),
    );
    await tester.pump(const Duration(seconds: 1));
    await tester.pumpAndSettle();

    expect(find.byType(TextField), findsOneWidget,
        reason: 'the ticker never told the screen — the worker is locked out '
            'until some unrelated rebuild happens to arrive');
  });

  testWidgets('v2 lever OFF: a cool-down never locks the composer',
      (WidgetTester tester) async {
    BbRemoteConfig.instance.debugSetSnapshot(<String, Object>{
      BbRemoteConfig.kKeyChatCompanionEnabled: true,
      BbRemoteConfig.kKeyChatCompanionV2Enabled: false,
    });
    when(() => repo.openCompanion()).thenAnswer(
      (_) async => CompanionOpening(
        CompanionOpenOutcome.companion,
        ChatTurn(
          reply: 'Thodi der ruk jaayein.',
          companion: true,
          digestKey: 'k1',
          cooldownUntil: DateTime.now().add(const Duration(minutes: 2)),
        ),
      ),
    );
    await pumpTab(tester);
    expect(find.byType(TextField), findsOneWidget);
  });

  // ── #1824 F1 — A MODEL-WRITTEN TURN IS NEVER READ ALOUD ────────────────────
  //
  // ADR-0046 O9. The bubble's shipped read-aloud speaks `ttsText ?? text`, and a
  // career answer has no reviewed Devanagari twin — so the fallback would read
  // the model's raw romanized Hinglish in a hi-IN voice. No speaker is offered.
  testWidgets('read_aloud:false — no speaker button on that bubble',
      (WidgetTester tester) async {
    companionSwitch(true);
    when(() => repo.openCompanion()).thenAnswer(
      (_) async => CompanionOpening(
        CompanionOpenOutcome.companion,
        const ChatTurn(
          reply: 'Welding mein aage badhne ke liye NDT seekhein.',
          companion: true,
          digestKey: 'k1',
          readAloud: false,
        ),
      ),
    );
    await pumpTab(tester);

    expect(find.text('Welding mein aage badhne ke liye NDT seekhein.'),
        findsOneWidget);
    expect(find.byIcon(Icons.volume_up_rounded), findsNothing,
        reason: 'a model-written bubble must offer no read-aloud');
  });

  testWidgets('a turn WITHOUT read_aloud keeps its speaker, exactly as before',
      (WidgetTester tester) async {
    companionSwitch(true);
    when(() => repo.openCompanion()).thenAnswer(
      (_) async => CompanionOpening(
        CompanionOpenOutcome.companion,
        const ChatTurn(
          reply: 'Aapki profile taiyaar hai.',
          ttsText: 'आपकी प्रोफ़ाइल तैयार है।',
          companion: true,
          digestKey: 'k1',
        ),
      ),
    );
    await pumpTab(tester);
    expect(find.byIcon(Icons.volume_up_rounded), findsWidgets,
        reason: 'fixed copy has a reviewed twin and is still read aloud');
  });

  // ── #1824 F2 — THE CAREER ANSWER RENDERS AS SEPARATE LINES ─────────────────
  testWidgets('a multi-line reply keeps its lines, and its 3 chips post',
      (WidgetTester tester) async {
    companionSwitch(true);
    const String answer = 'Welding mein teen raaste hain.\n'
        'NDT certificate sabse tez hai.\n'
        'Uske baad supervisor ban sakte hain.';
    when(() => repo.openCompanion()).thenAnswer(
      (_) async => CompanionOpening(
        CompanionOpenOutcome.companion,
        const ChatTurn(
          reply: answer,
          followups: <String>['NDT kya hai', 'Kitna kharcha', 'Kahan seekhein'],
          companion: true,
          digestKey: 'k1',
          readAloud: false,
        ),
      ),
    );
    when(() => repo.sendCompanionMessage(any(),
            submissionId: any(named: 'submissionId')))
        .thenAnswer((_) async => _companion('Theek hai.', const <ChatOption>[]));
    await pumpTab(tester);

    // The bubble holds the text VERBATIM — the newlines are the model's own
    // structure and Text renders them as real lines.
    final Finder bubble = find.text(answer);
    expect(bubble, findsOneWidget);
    expect(tester.widget<Text>(bubble).data!.split('\n'), hasLength(3));

    // The three model-written followups are offered and post as ordinary text.
    expect(find.text('NDT kya hai'), findsOneWidget);
    await tester.tap(find.text('Kitna kharcha'));
    await tester.pumpAndSettle();
    verify(() => repo.sendCompanionMessage('Kitna kharcha',
        submissionId: any(named: 'submissionId'))).called(1);
  });

  // ── #1821 F2 / #1824 F2 — THE P2 AND P3 TASK CHIPS ─────────────────────────
  testWidgets('the new-resume and career-talk chips render and post their LABEL',
      (WidgetTester tester) async {
    companionSwitch(true);
    when(() => repo.openCompanion()).thenAnswer(
      (_) async => CompanionOpening(
        CompanionOpenOutcome.companion,
        const ChatTurn(
          reply: _recap,
          suggestedOptions: <ChatOption>[
            ChatOption(
              optionKey: kCompanionTaskNewResumeKey,
              labelText: 'Naya resume',
            ),
            ChatOption(
              optionKey: kCompanionTaskCareerTalkKey,
              labelText: 'Career ki baat',
            ),
          ],
          questionKind: ChatQuestionKind.disambiguate,
          companion: true,
          digestKey: 'k1',
        ),
      ),
    );
    when(() => repo.sendCompanionMessage(any(),
            submissionId: any(named: 'submissionId')))
        .thenAnswer((_) async => _companion('Theek hai.', const <ChatOption>[]));
    await pumpTab(tester);

    expect(find.text('Naya resume'), findsOneWidget);
    expect(find.text('Career ki baat'), findsOneWidget);
    // Neither resolves to a client route — the test router has none, so a
    // client-side route would throw instead of POSTing.
    await tester.tap(find.text('Career ki baat'));
    await tester.pumpAndSettle();
    verify(() => repo.sendCompanionMessage('Career ki baat',
        submissionId: any(named: 'submissionId'))).called(1);
  });

  // ── ADR-0046 F4 — THE LEVER OFF IS TODAY'S SHIPPED STATE ───────────────────
  //
  // `worker_chat_companion_v2_enabled` is false on every device right now, and
  // every other test in this file turns it on with its v1 twin. So this is the
  // state real workers are in, and the one nothing covered: v1 companion ON,
  // v2 OFF.
  testWidgets('v2 lever OFF: no task chip, no mic — and v1 chips untouched',
      (WidgetTester tester) async {
    // v1 on, v2 OFF — deliberately NOT companionSwitch(), which flips both.
    BbRemoteConfig.instance.debugSetSnapshot(<String, Object>{
      BbRemoteConfig.kKeyChatCompanionEnabled: true,
      BbRemoteConfig.kKeyChatCompanionV2Enabled: false,
    });
    when(() => repo.openCompanion()).thenAnswer(
      (_) async => CompanionOpening(
        CompanionOpenOutcome.companion,
        const ChatTurn(
          reply: _recap,
          suggestedOptions: <ChatOption>[
            // A v1 chip and a v2 task chip on the SAME turn: only the v2 one
            // may be withheld.
            ChatOption(
              optionKey: kCompanionJobsTabKey,
              labelText: 'Sabhi jobs dekhein',
            ),
            ChatOption(
              optionKey: kCompanionTaskEditResumeKey,
              labelText: 'Resume badlo',
            ),
          ],
          questionKind: ChatQuestionKind.disambiguate,
          companion: true,
          digestKey: 'k1',
        ),
      ),
    );
    await pumpTab(tester);

    // The v2 door is not drawn: its room (the edit card) is gated off too, so
    // offering it would strand the worker.
    expect(find.text('Resume badlo'), findsNothing);
    // v1 is completely untouched by the gate.
    expect(find.text('Sabhi jobs dekhein'), findsOneWidget);
    // F3's mic is gated by the same lever. Keyed, because the screen also draws
    // the shipped composer's own dictation mic, which this lever must NOT touch.
    expect(find.byKey(kCompanionVoiceButtonKey), findsNothing);
  });

  testWidgets('v2 lever OFF: an edit card on the turn still draws nothing',
      (WidgetTester tester) async {
    BbRemoteConfig.instance.debugSetSnapshot(<String, Object>{
      BbRemoteConfig.kKeyChatCompanionEnabled: true,
      BbRemoteConfig.kKeyChatCompanionV2Enabled: false,
    });
    when(() => repo.openCompanion()).thenAnswer(
      (_) async => CompanionOpening(
        CompanionOpenOutcome.companion,
        ChatTurn(
          reply: _recap,
          companion: true,
          digestKey: 'k1',
          editProposal: EditProposal(
            proposalId: 'p1',
            expiresAt: DateTime.now().add(const Duration(minutes: 5)),
            rows: const <EditProposalRow>[
              EditProposalRow(
                rowId: 'r1',
                sectionLabel: 'Skills',
                op: 'add',
                after: 'Welding',
              ),
            ],
          ),
        ),
      ),
    );
    await pumpTab(tester);

    // A server that proposes an edit to a lever-off build is ignored, not drawn.
    expect(find.text('Skills'), findsNothing);
    expect(find.text('Welding'), findsNothing);
  });

  // ── ADR-0046 F3 — THE COMPANION VOICE BUTTON ───────────────────────────────
  testWidgets('the voice button opens the voice screen in COMPOSE mode and lands the transcript in the composer',
      (WidgetTester tester) async {
    companionSwitch(true);
    final SemanticsHandle handle = tester.ensureSemantics();
    await pumpTab(tester);

    await tester.tap(find.bySemanticsLabel('Bolkar likhein'));
    await tester.pumpAndSettle();

    // `extra: true` reached the route: the stand-in renders its compose face.
    expect(find.text('COMPOSE VOICE'), findsOneWidget);
    await tester.tap(find.text('COMPOSE VOICE'));
    await tester.pumpAndSettle();

    // The transcript is in the composer, unsent — the worker reviews and sends.
    expect(find.widgetWithText(TextField, 'boli hui baat'), findsOneWidget);
    verifyNever(() => repo.sendCompanionMessage(any(),
        submissionId: any(named: 'submissionId')));
    handle.dispose();
  });
}
