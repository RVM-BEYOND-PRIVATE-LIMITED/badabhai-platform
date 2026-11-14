import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:get_it/get_it.dart';

import 'package:payer_app/core/audio/speech_dictation.dart';
import 'package:payer_app/core/auth/payer_token_store.dart';
import 'package:payer_app/core/data/mock_payer_api_client.dart';
import 'package:payer_app/core/data/models.dart';
import 'package:payer_app/core/di/locator.dart';
import 'package:payer_app/core/session/app_session.dart';
import 'package:payer_app/core/session/app_session_cubit.dart';
import 'package:payer_app/features/jobs/presentation/post_job_screen.dart';

const PostingTradeForm _welder = PostingTradeForm(
  roleKind: 'welder',
  roleLabel: 'Welder',
  packId: 'qp_welding_trade',
  matchSkillId: 'mskill_welder',
);

class _DraftApi extends MockPayerApiClient {
  String? spoken;
  String? tradeLabel;
  String? roleLabel;
  JobDescriptionDraft response =
      const JobDescriptionDraft(description: 'English draft.', isMock: true);

  @override
  Future<List<MatchSkill>> fetchMatchSkills() async => const <MatchSkill>[];

  @override
  Future<List<PostingTradeForm>> fetchPostingTrades() async =>
      <PostingTradeForm>[_welder];

  @override
  Future<JobDescriptionDraft> draftJobDescription({
    required String spokenText,
    String? tradeLabel,
    String? roleLabel,
  }) async {
    spoken = spokenText;
    this.tradeLabel = tradeLabel;
    this.roleLabel = roleLabel;
    return response;
  }
}

class _FakeDictation implements SpeechDictation {
  _FakeDictation({this.ready = true});

  final bool ready;
  void Function(String words, bool isFinal)? _onResult;
  VoidCallback? _onDone;
  bool _listening = false;
  int listens = 0;
  int cancels = 0;

  @override
  Future<bool> initialize() async => ready;

  @override
  Future<void> listen({
    required void Function(String words, bool isFinal) onResult,
    required VoidCallback onDone,
    String localeId = 'hi_IN',
  }) async {
    listens += 1;
    _onResult = onResult;
    _onDone = onDone;
    _listening = true;
  }

  /// The recogniser settles an utterance and the platform ends the session.
  void say(String words) {
    _onResult?.call(words, true);
    _onDone?.call();
  }

  @override
  Future<void> stop() async {
    _listening = false;
  }

  @override
  Future<void> cancel() async {
    cancels += 1;
    _listening = false;
  }

  @override
  bool get isListening => _listening;
}

void main() {
  late _DraftApi api;
  late _FakeDictation dictation;

  Future<void> pump(WidgetTester tester) async {
    await GetIt.instance.reset();
    api = _DraftApi();
    dictation = _FakeDictation();
    setupLocator(apiClient: api, secureStore: InMemoryKeyValueStore());
    locator<AppSessionCubit>().signIn(PayerRole.company);

    tester.view.physicalSize = const Size(1000, 4000);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: PostJobScreen(onBack: () {}, dictation: dictation),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  Future<void> typeInto(
    WidgetTester tester,
    String label,
    String value,
  ) async {
    final Finder field = find.ancestor(
      of: find.text(label),
      matching: find.byType(Column),
    );
    await tester.enterText(
      find.descendant(of: field.first, matching: find.byType(TextField)),
      value,
    );
    await tester.pump();
  }

  Future<void> goToStep(WidgetTester tester, int step) async {
    final Finder tab = find.byKey(Key('post_job_step_$step'));
    await tester.ensureVisible(tab);
    await tester.pumpAndSettle();
    await tester.tap(tab);
    await tester.pumpAndSettle();
  }

  Future<void> pickTrade(WidgetTester tester) async {
    await tester.tap(find.text('— pick the role —'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Welder').last);
    await tester.pumpAndSettle();
    // The wizard keeps the description and its voice control on step 4.
    await goToStep(tester, 3);
  }

  String descriptionText(WidgetTester tester) {
    final Finder field = find.ancestor(
      of: find.text('Description'),
      matching: find.byType(Column),
    );
    return tester
        .widget<TextField>(
          find.descendant(of: field.first, matching: find.byType(TextField)),
        )
        .controller!
        .text;
  }

  testWidgets('a spoken Hinglish note fills the editable English draft', (
    WidgetTester tester,
  ) async {
    await pump(tester);
    await typeInto(tester, 'Job title', 'Senior Welder');
    await pickTrade(tester);

    await tester.tap(find.byKey(const Key('voice_description_button')));
    await tester.pump();

    dictation.say('yeh kaam welding ka hai, night shift mein');
    await tester.pumpAndSettle();

    expect(descriptionText(tester), 'English draft.');
    // The transcript and the Step-1 trade/role labels ride the POST.
    expect(api.spoken, 'yeh kaam welding ka hai, night shift mein');
    expect(api.tradeLabel, 'Welder');
    expect(api.roleLabel, 'Senior Welder');
    expect(find.text('Draft added. Review it before posting.'), findsOneWidget);
  });

  testWidgets('a null draft keeps the typed text and offers a retry', (
    WidgetTester tester,
  ) async {
    await pump(tester);
    await typeInto(tester, 'Job title', 'Senior Welder');
    await pickTrade(tester);
    await typeInto(tester, 'Description', 'My own description.');

    api.response = const JobDescriptionDraft(description: null, isMock: true);

    await tester.tap(find.byKey(const Key('voice_description_button')));
    await tester.pump();
    dictation.say('kuch bhi nahi');
    await tester.pumpAndSettle();

    // The poster's own words are untouched...
    expect(descriptionText(tester), 'My own description.');
    // ...and the small retry state is shown.
    expect(
      find.text('No draft this time. Your text is unchanged — retry or keep it.'),
      findsOneWidget,
    );
    expect(find.byKey(const Key('voice_description_retry')), findsOneWidget);
  });

  testWidgets('a denied microphone leaves typing untouched', (
    WidgetTester tester,
  ) async {
    await GetIt.instance.reset();
    api = _DraftApi();
    dictation = _FakeDictation(ready: false);
    setupLocator(apiClient: api, secureStore: InMemoryKeyValueStore());
    locator<AppSessionCubit>().signIn(PayerRole.company);
    tester.view.physicalSize = const Size(1000, 4000);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: PostJobScreen(onBack: () {}, dictation: dictation),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await goToStep(tester, 3);

    await tester.tap(find.byKey(const Key('voice_description_button')));
    await tester.pumpAndSettle();

    expect(api.spoken, isNull);
    expect(
      find.text('Microphone unavailable. Type the description instead.'),
      findsOneWidget,
    );
  });
}
