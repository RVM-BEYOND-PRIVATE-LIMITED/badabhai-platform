// OWNER ASK (2026-10-22) — "I don't agree" to voice recording on the privacy
// screen hides every voice control in the app; the worker types instead.
//
// This suite pins the three pieces that make that true: the store fails
// CLOSED (unknown = no voice), the consent cubit records the answer the worker
// gave, and a voice control (the work-description mic) disappears on a "no".
import 'package:bloc_test/bloc_test.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/consent/voice_consent.dart';
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/features/consent/domain/consent_repository.dart';
import 'package:badabhai_worker_app/features/consent/presentation/cubit/consent_cubit.dart';
import 'package:badabhai_worker_app/features/trade_form/presentation/widgets/trade_form_work_dictation.dart';
import 'package:badabhai_worker_app/features/voice/domain/speech_dictation.dart';

import '../../features/voice/dictation_controller_test.dart' show FakeDictation;

class _MockConsentRepository extends Mock implements ConsentRepository {}

void main() {
  setUpAll(() => registerFallbackValue(const <String>[]));

  late bool harnessDefault;
  setUp(() {
    // The harness treats UNKNOWN as granted so older suites keep their mics;
    // this suite proves the real (fail-closed) default.
    harnessDefault = VoiceConsent.debugUnknownMeansGranted;
    VoiceConsent.debugUnknownMeansGranted = false;
    VoiceConsent.instance.clear();
  });
  tearDown(() {
    VoiceConsent.instance.clear();
    VoiceConsent.debugUnknownMeansGranted = harnessDefault;
  });

  group('VoiceConsent store', () {
    test('unknown answer hides voice (fail closed)', () {
      expect(VoiceConsent.instance.state.value, isNull);
      expect(VoiceConsent.instance.voiceAllowed, isFalse);
    });

    test('granted shows voice; declined hides it', () {
      VoiceConsent.instance.set(granted: true);
      expect(VoiceConsent.instance.voiceAllowed, isTrue);
      VoiceConsent.instance.set(granted: false);
      expect(VoiceConsent.instance.voiceAllowed, isFalse);
    });

    test('server purposes decide it', () {
      VoiceConsent.instance.setFromPurposes(
        const <String>['profiling', 'resume_generation', 'voice_processing'],
      );
      expect(VoiceConsent.instance.state.value, isTrue);
      VoiceConsent.instance.setFromPurposes(
        const <String>['profiling', 'resume_generation'],
      );
      expect(VoiceConsent.instance.state.value, isFalse);
    });

    test('logout forgets the answer', () {
      VoiceConsent.instance.set(granted: true);
      VoiceConsent.instance.clear();
      expect(VoiceConsent.instance.state.value, isNull);
      expect(VoiceConsent.instance.voiceAllowed, isFalse);
    });
  });

  group('ConsentCubit records the voice answer', () {
    late _MockConsentRepository repo;
    setUp(() {
      repo = _MockConsentRepository();
      when(() => repo.acceptConsent(purposes: any(named: 'purposes')))
          .thenAnswer((_) async {});
    });

    blocTest<ConsentCubit, ConsentState>(
      'decline gives every purpose except voice and hides voice',
      build: () => ConsentCubit(repo),
      act: (ConsentCubit c) => c.decline(),
      expect: () => const <ConsentState>[
        ConsentState(status: ConsentStatus.submitting),
        ConsentState(status: ConsentStatus.success),
      ],
      verify: (_) {
        verify(
          () => repo.acceptConsent(
            purposes: <String>['profiling', 'resume_generation'],
          ),
        ).called(1);
        expect(VoiceConsent.instance.state.value, isFalse);
        expect(VoiceConsent.instance.voiceAllowed, isFalse);
      },
    );

    blocTest<ConsentCubit, ConsentState>(
      'agree gives voice too and shows voice',
      build: () => ConsentCubit(repo),
      seed: () => const ConsentState(accepted: true),
      act: (ConsentCubit c) => c.submit(),
      verify: (_) {
        verify(
          () => repo.acceptConsent(
            purposes: <String>[
              'profiling',
              'resume_generation',
              'voice_processing',
            ],
          ),
        ).called(1);
        expect(VoiceConsent.instance.state.value, isTrue);
      },
    );

    blocTest<ConsentCubit, ConsentState>(
      'a failed decline does not record an answer',
      build: () {
        when(() => repo.acceptConsent(purposes: any(named: 'purposes')))
            .thenThrow(const NetworkFailure());
        return ConsentCubit(repo);
      },
      act: (ConsentCubit c) => c.decline(),
      verify: (_) => expect(VoiceConsent.instance.state.value, isNull),
    );
  });

  group('voice controls follow the answer', () {
    late TextEditingController field;
    setUp(() async {
      await locator.reset();
      locator.registerSingleton<SpeechDictation>(FakeDictation());
      field = TextEditingController();
    });
    tearDown(() async {
      field.dispose();
      await locator.reset();
    });

    Future<void> pump(WidgetTester tester) async {
      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.light(),
          home: Scaffold(
            body: TradeFormWorkDictation(
              controller: field,
              enabled: true,
              maxLength: 300,
              onText: (_) {},
            ),
          ),
        ),
      );
      await tester.pump();
    }

    testWidgets('work-description mic hidden when voice declined', (
      WidgetTester tester,
    ) async {
      VoiceConsent.instance.set(granted: false);
      await pump(tester);
      expect(find.byKey(kWorkDictationButtonKey), findsNothing);
    });

    testWidgets('work-description mic hidden while the answer is unknown', (
      WidgetTester tester,
    ) async {
      await pump(tester);
      expect(find.byKey(kWorkDictationButtonKey), findsNothing);
    });

    testWidgets('mic appears as soon as voice is granted', (
      WidgetTester tester,
    ) async {
      VoiceConsent.instance.set(granted: false);
      await pump(tester);
      VoiceConsent.instance.set(granted: true);
      await tester.pump();
      expect(find.byKey(kWorkDictationButtonKey), findsOneWidget);
    });
  });
}
