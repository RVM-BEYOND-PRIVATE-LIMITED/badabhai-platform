import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:get_it/get_it.dart';

import 'package:payer_app/core/auth/payer_token_store.dart';
import 'package:payer_app/core/data/job_posting_chat_models.dart';
import 'package:payer_app/core/data/mock_payer_api_client.dart';
import 'package:payer_app/core/data/models.dart';
import 'package:payer_app/core/di/locator.dart';
import 'package:payer_app/core/widgets/bb_button.dart';
import 'package:payer_app/core/widgets/bb_shake.dart';
import 'package:payer_app/features/job_posting_chat/presentation/job_posting_chat_screen.dart';
import 'package:payer_app/features/job_posting_chat/presentation/widgets/draft_preview.dart';

/// #2635, through the whole chat (screen → bloc → repository → client): the
/// posting a chat publish creates is a company DRAFT, and a company draft with
/// no trade can never go live. So a READY draft still cannot be published until
/// one of the 16 trades is picked — the tap is refused at the picker and no
/// publish request is made.
class _ChatApi extends MockPayerApiClient {
  /// The `role_kind` of every publish the client was asked for.
  final List<String?> published = <String?>[];

  /// A conversation started elsewhere whose draft the engine has called ready.
  @override
  Future<JobPostingChatTranscript?> fetchJobPostingChatTranscript(
    String sessionId,
  ) async =>
      JobPostingChatTranscript(
        sessionId: sessionId,
        draft: const JobPostingDraft(
          roleTitle: 'CNC Setter',
          vacancyBand: '2-5',
          city: 'Pune',
        ),
        draftReady: true,
        messages: const <JobPostingChatMessageRow>[
          JobPostingChatMessageRow(fromPayer: false, bodyText: 'Kaunsa kaam?'),
          JobPostingChatMessageRow(fromPayer: true, bodyText: 'CNC Setter'),
        ],
      );

  @override
  Future<PublishJobResult> publishJobPostingChatSession(
    String sessionId, {
    String? roleKind,
    String? area,
  }) async {
    published.add(roleKind);
    return const PublishJobResult(jobPostingId: 'job-1');
  }
}

void main() {
  testWidgets(
      'a ready draft is not published without one of the 16 trades — and is, '
      'with one', (WidgetTester tester) async {
    final _ChatApi api = _ChatApi();
    await GetIt.instance.reset();
    setupLocator(apiClient: api, secureStore: InMemoryKeyValueStore());
    int backs = 0;

    // Tall enough that the lazily built transcript list builds the draft panel.
    tester.view.physicalSize = const Size(1000, 3000);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: JobPostingChatScreen(
            onBack: () => backs++,
            resumeSessionId: 'web-session-7',
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    // The ready draft opened its panel; the picker lists the catalogue's
    // trades (the mock serves CNC Turner and Welder).
    expect(find.byType(DraftPreview), findsOneWidget);
    expect(find.text('— pick the role —'), findsOneWidget);

    final Finder publish = find.widgetWithText(BbButton, kDraftPublishLabel);
    await tester.tap(publish);
    await tester.pumpAndSettle();

    expect(api.published, isEmpty, reason: 'no trade, no publish request');
    expect(
      find.descendant(
        of: find.ancestor(of: find.text('Role'), matching: find.byType(BbShake)),
        matching: find.text('Pick one of the 16 trades'),
      ),
      findsOneWidget,
    );

    await tester.tap(find.text('— pick the role —'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Welder').last);
    await tester.pumpAndSettle();
    expect(find.text('Pick one of the 16 trades'), findsNothing);

    await tester.tap(publish);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));

    expect(api.published, <String?>['welder']);
    expect(backs, 1, reason: 'a published chat hands back to My jobs');
    // Drain the success toast's timer.
    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();
  });
}
