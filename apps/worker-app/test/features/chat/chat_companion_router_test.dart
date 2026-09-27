import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:google_fonts/google_fonts.dart';

import 'package:badabhai_worker_app/core/api/mock_api_client.dart';
import 'package:badabhai_worker_app/core/config/remote_config.dart';
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/features/chat/presentation/chat_profiling_screen.dart';
import 'package:badabhai_worker_app/router.dart';

/// #1755.2 — THE TAB-ONLY RULE, AGAINST THE REAL ROUTER.
///
/// The companion is asked for by the `/bada-bhai` TAB and by nothing else. Every
/// other test of that rule builds its own `GoRouter` with a hand-written
/// `ChatProfilingScreen`, so setting `assistantTab: true` on the onboarding
/// `/chat` builder — or dropping it from the tab builder — would leave the whole
/// suite green while breaking the owner's rule that `/chat` stays byte-for-byte
/// what it was.
void main() {
  setUp(() async {
    GoogleFonts.config.allowRuntimeFetching = false;
    await locator.reset();
    setupLocator(apiClient: MockApiClient());
    // The switch is ON for both navigations: the ROUTE is what must differ.
    BbRemoteConfig.instance.debugSetSnapshot(
      <String, Object>{BbRemoteConfig.kKeyChatCompanionEnabled: true},
    );
  });

  tearDown(() {
    BbRemoteConfig.instance.debugReset();
  });

  /// The TOPMOST chat screen — the one the route just built.
  ///
  /// The shell keeps the Bada Bhai branch alive while `/chat` is pushed over it,
  /// so both screens are mounted at once; `.last` is the one on top.
  bool assistantTabOf(WidgetTester tester) => tester
      .widgetList<ChatProfilingScreen>(find.byType(ChatProfilingScreen))
      .last
      .assistantTab;

  testWidgets('/chat never asks for the companion; /bada-bhai always does',
      (WidgetTester tester) async {
    tester.view.physicalSize = const Size(400, 1000);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final GoRouter router = buildAppRouter();
    await tester.pumpWidget(MaterialApp.router(routerConfig: router));
    await tester.pump();

    router.go(Routes.chatProfiling);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.byType(ChatProfilingScreen), findsWidgets);
    expect(assistantTabOf(tester), isFalse,
        reason: 'the onboarding interview route must never open the companion');

    router.go(Routes.badaBhai);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.byType(ChatProfilingScreen), findsWidgets);
    expect(assistantTabOf(tester), isTrue,
        reason: 'the Bada Bhai tab is the one surface that opens the companion');
  });
}
