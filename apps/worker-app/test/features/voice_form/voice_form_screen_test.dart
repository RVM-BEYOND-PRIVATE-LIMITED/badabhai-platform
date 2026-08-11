import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:record/record.dart';

import 'package:badabhai_worker_app/features/voice/data/session_voice_recorder.dart';
import 'package:badabhai_worker_app/features/voice_form/domain/question_audio_player.dart';
import 'package:badabhai_worker_app/features/voice_form/domain/silence_endpointer.dart';
import 'package:badabhai_worker_app/features/voice_form/domain/voice_form_gateway.dart';
import 'package:badabhai_worker_app/features/voice_form/domain/voice_correction_outcome.dart';
import 'package:badabhai_worker_app/features/voice_form/domain/voice_form_models.dart';
import 'package:badabhai_worker_app/features/voice_form/presentation/cubit/voice_form_cubit.dart';
import 'package:badabhai_worker_app/features/voice_form/presentation/voice_form_screen.dart';
import 'package:badabhai_worker_app/features/voice_form/presentation/widgets/voice_dot_rail.dart';
import 'package:badabhai_worker_app/features/voice_form/presentation/widgets/voice_level_meter.dart';
import 'voice_form_doubles.dart';

class MockAudioRecorder extends Mock implements AudioRecorder {}

class FakeTts implements QuestionAudioPlayer {
  @override
  Future<void> play(VoiceQuestion question) async {}
  @override
  Future<void> stop() async {}
}

/// One open question with a whyText, then done.
class OneQuestionGateway implements VoiceFormGateway {
  @override
  String? get sessionId => 'sess-test';

  final List<VoiceAnswer> received = <VoiceAnswer>[];

  @override
  Future<VoiceFormStep> start() async => const NextQuestion(
        VoiceQuestion(
          id: 'q1',
          prompt: 'Aap kaunsa kaam karte hain?',
          whyText: 'Isse sahi naukri milti hai.',
        ),
        index: 1,
        total: 8,
      );

  @override
  Future<VoiceFormStep> submit(VoiceAnswer answer, {String? questionKey}) async {
    received.add(answer);
    return const VoiceFormDone();
  }

  @override
  Future<void> finalize() async {}


  @override
  Future<VoiceCorrectionOutcome> correct(
    VoiceAnswer answer, {
    required String questionKey,
  }) => throw UnimplementedError();
}

void main() {
  setUpAll(() {
    registerFallbackValue(const RecordConfig());
    registerFallbackValue(Duration.zero);
  });

  late MockAudioRecorder plugin;

  setUp(() {
    plugin = MockAudioRecorder();
    when(() => plugin.hasPermission()).thenAnswer((_) async => true);
    when(() => plugin.start(any(), path: any(named: 'path')))
        .thenAnswer((_) async {});
    when(() => plugin.cancel()).thenAnswer((_) async {});
    when(() => plugin.dispose()).thenAnswer((_) async {});
    when(() => plugin.stop()).thenAnswer((_) async => 'clip.m4a');
    when(() => plugin.onAmplitudeChanged(any()))
        .thenAnswer((_) => const Stream<Amplitude>.empty());
    when(() => plugin.onStateChanged())
        .thenAnswer((_) => const Stream<RecordState>.empty());
  });

  VoiceFormCubit makeCubit(OneQuestionGateway gateway) => VoiceFormCubit(
        gateway: gateway,
        recorder: SessionVoiceRecorder(recorder: plugin),
        endpointer: SilenceEndpointer(),
        tts: FakeTts(),
        registrar: FakeRegistrar(),
        session: testSession(),
        sleep: (_) async {},
      );

  // The recorder's start() sweeps the real temp dir (real IO) and arms a real
  // auto-stop timer — both must run OUTSIDE testWidgets' FakeAsync, or the test
  // hangs. runAsync is the sanctioned escape hatch; close() there cancels the
  // real timer + subscriptions.
  Future<void> present(WidgetTester t, VoiceFormCubit cubit) async {
    await t.runAsync(() => cubit.start());
    await t.pumpWidget(MaterialApp(home: VoiceFormScreen(cubit: cubit)));
    await t.pump();
  }

  testWidgets('the dot rail renders no numeral / denominator (#629)',
      (WidgetTester t) async {
    final OneQuestionGateway gateway = OneQuestionGateway();
    final VoiceFormCubit cubit = makeCubit(gateway);
    await present(t, cubit);

    expect(find.byType(VoiceDotRail), findsOneWidget);
    for (final Text w in t.widgetList<Text>(find.byType(Text))) {
      final String s = w.data ?? '';
      expect(RegExp(r'\d').hasMatch(s), isFalse,
          reason: 'no numeral should render, found: "$s"');
      expect(s.contains('/'), isFalse, reason: 'no denominator: "$s"');
    }

    await t.runAsync(() => cubit.close());
  });

  testWidgets('the info why-text is collapsed by default and expands inline',
      (WidgetTester t) async {
    final OneQuestionGateway gateway = OneQuestionGateway();
    final VoiceFormCubit cubit = makeCubit(gateway);
    await present(t, cubit);

    expect(find.text('Isse sahi naukri milti hai.'), findsNothing);
    await t.tap(find.text('Yeh kyun poochh rahe hain'));
    await t.pump();
    expect(find.text('Isse sahi naukri milti hai.'), findsOneWidget);

    await t.runAsync(() => cubit.close());
  });

  testWidgets('"Nahi pata" submits the literal text (engine to declined)',
      (WidgetTester t) async {
    final OneQuestionGateway gateway = OneQuestionGateway();
    final VoiceFormCubit cubit = makeCubit(gateway);
    await present(t, cubit);

    await t.runAsync(() async {
      await t.tap(find.text('Nahi pata'));
      await Future<void>.delayed(Duration.zero);
    });
    await t.pump();

    expect(gateway.received.single.kind, VoiceAnswerKind.text);
    expect(gateway.received.single.text, 'Nahi pata');

    await t.runAsync(() => cubit.close());
  });

  group('level meter fraction', () {
    test('covering the mic (a quieter dBFS) yields a smaller fraction', () {
      expect(levelFraction(-5), greaterThan(levelFraction(-55)));
      expect(levelFraction(-60), 0.0);
      expect(levelFraction(0), 1.0);
    });
  });
}
