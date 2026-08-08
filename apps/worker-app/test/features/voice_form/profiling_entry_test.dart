import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/features/voice_form/domain/question_audio_player.dart';
import 'package:badabhai_worker_app/features/voice_form/domain/voice_form_models.dart';
import 'package:badabhai_worker_app/features/voice_form/presentation/profiling_entry.dart';
import 'package:badabhai_worker_app/features/voice_form/presentation/voice_form_entry_chooser.dart';

class CountingIntro implements QuestionAudioPlayer {
  int plays = 0;
  @override
  Future<void> play(VoiceQuestion question) async => plays++;
  @override
  Future<void> stop() async {}
}

void main() {
  group('resolveProfilingEntry (#638)', () {
    test('kill switch ON → straight to chat, no chooser', () {
      final ProfilingEntry entry =
          resolveProfilingEntry(voiceFormHidden: true);
      expect(entry, isA<ProfilingGoDirect>());
      expect((entry as ProfilingGoDirect).path, ProfilingPath.chat);
    });

    test('kill switch OFF → chooser with both paths', () {
      final ProfilingEntry entry =
          resolveProfilingEntry(voiceFormHidden: false);
      expect(entry, isA<ProfilingShowChooser>());
      expect((entry as ProfilingShowChooser).paths,
          <ProfilingPath>[ProfilingPath.chat, ProfilingPath.voiceForm]);
    });

    test('a one-option chooser is never produced', () {
      for (final bool hidden in <bool>[true, false]) {
        final ProfilingEntry entry =
            resolveProfilingEntry(voiceFormHidden: hidden);
        if (entry is ProfilingShowChooser) {
          expect(entry.paths.length, greaterThanOrEqualTo(2));
        }
      }
    });
  });

  group('VoiceFormEntryChooser (#638)', () {
    testWidgets('renders both cards, autoplays the intro once, routes on tap',
        (WidgetTester t) async {
      final CountingIntro intro = CountingIntro();
      ProfilingPath? chosen;
      await t.pumpWidget(MaterialApp(
        home: VoiceFormEntryChooser(
          intro: intro,
          onChoose: (ProfilingPath p) => chosen = p,
        ),
      ));

      expect(find.text('Sawaal-jawaab'), findsOneWidget);
      expect(find.text('Khul kar baat'), findsOneWidget);
      expect(intro.plays, 1, reason: 'the spoken intro autoplays for a non-reader');

      await t.tap(find.text('Sawaal-jawaab'));
      expect(chosen, ProfilingPath.voiceForm);

      await t.tap(find.text('Khul kar baat'));
      expect(chosen, ProfilingPath.chat);
    });
  });
}
