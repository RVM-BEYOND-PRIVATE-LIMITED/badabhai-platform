// #421 — the interview-completeness gate on the "build my profile" CTA.
//
// The backend has always sent `extraction_ready` on every chat reply
// (apps/api/src/chat/chat.service.ts) and the app never read it, so a worker
// could tap "Done" after one message and get a sparse profile. This suite pins
// the whole chain: JSON -> ChatReply -> ChatTurn -> ChatState -> the CTA.
//
// It also pins the two DESIGN decisions, because both are load-bearing:
//   * a MISSING `extraction_ready` parses as false (never true) — a parse miss
//     must not silently delete the gate;
//   * not-ready SOFTENS the CTA, it does not kill it — the sheet's escape hatch
//     still reaches the profile preview, so a false negative can never trap a
//     worker in the chat.
//
// This file is the PARSE + BLOC + OPENER half and imports no screen, so it runs
// everywhere. The CTA/nudge widget assertions live in
// chat_done_gate_screen_test.dart (see its header for why they are separate).
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart';
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_repository.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_turn.dart';
import 'package:badabhai_worker_app/features/chat/presentation/bloc/chat_bloc.dart';

class MockChatRepository extends Mock implements ChatRepository {}

void main() {
  late MockChatRepository repo;

  setUp(() async {
    repo = MockChatRepository();
    await locator.reset();
    locator.registerFactory<ChatBloc>(() => ChatBloc(repo));
    when(() => repo.ensureSession()).thenAnswer((_) async {});
  });

  tearDown(() async => locator.reset());

  // ---------------------------------------------------------------- parsing

  group('ChatReply.extractionReady parsing (#421)', () {
    test('reads extraction_ready: true', () {
      final ChatReply reply = ChatReply.fromJson(<String, dynamic>{
        'reply': 'Theek hai.',
        'extraction_ready': true,
      });
      expect(reply.extractionReady, isTrue);
    });

    test('reads extraction_ready: false', () {
      final ChatReply reply = ChatReply.fromJson(<String, dynamic>{
        'reply': 'Theek hai.',
        'extraction_ready': false,
      });
      expect(reply.extractionReady, isFalse);
    });

    test('an ABSENT extraction_ready defaults to false (never true)', () {
      // The chosen default: a parse miss must degrade to "keep talking"
      // (recoverable — the CTA is still tappable via the nudge sheet), never to
      // "ready" (which would silently restore the #421 bug with no signal).
      final ChatReply reply =
          ChatReply.fromJson(<String, dynamic>{'reply': 'Theek hai.'});
      expect(reply.extractionReady, isFalse);
    });

    test('a null / non-bool extraction_ready degrades to false, not a throw',
        () {
      expect(
        ChatReply.fromJson(<String, dynamic>{
          'reply': 'Theek hai.',
          'extraction_ready': null,
        }).extractionReady,
        isFalse,
      );
      // #371 lesson: an unexpected type must not take down the whole reply.
      final ChatReply odd = ChatReply.fromJson(<String, dynamic>{
        'reply': 'Theek hai.',
        'extraction_ready': 'yes',
      });
      expect(odd.extractionReady, isFalse);
      expect(odd.reply, 'Theek hai.', reason: 'the reply itself survives');
    });
  });

  // ------------------------------------------------------------------- bloc

  group('ChatState.extractionReady (#421)', () {
    test('a reply with extraction_ready: true flips the state ready', () async {
      when(() => repo.sendMessage(any())).thenAnswer(
        (_) async => const ChatTurn(reply: 'Bas ho gaya.', extractionReady: true),
      );
      final ChatBloc bloc = ChatBloc(repo);
      addTearDown(bloc.close);

      expect(bloc.state.extractionReady, isFalse, reason: 'nothing said yet');
      bloc.add(const ChatMessageSent('CNC operator'));
      await Future<void>.delayed(const Duration(milliseconds: 50));

      expect(bloc.state.extractionReady, isTrue);
    });

    test('a reply with extraction_ready: false leaves the state not ready',
        () async {
      when(() => repo.sendMessage(any()))
          .thenAnswer((_) async => const ChatTurn(reply: 'Aur bataiye.'));
      final ChatBloc bloc = ChatBloc(repo);
      addTearDown(bloc.close);

      bloc.add(const ChatMessageSent('CNC operator'));
      await Future<void>.delayed(const Duration(milliseconds: 50));

      expect(bloc.state.extractionReady, isFalse);
    });

    test('readiness LATCHES — a later not-ready turn cannot un-ready the CTA',
        () async {
      int calls = 0;
      when(() => repo.sendMessage(any())).thenAnswer((_) async {
        calls++;
        // Ready first, then a degraded turn with no readiness flag.
        return ChatTurn(reply: 'r$calls', extractionReady: calls == 1);
      });
      final ChatBloc bloc = ChatBloc(repo);
      addTearDown(bloc.close);

      bloc.add(const ChatMessageSent('one'));
      await Future<void>.delayed(const Duration(milliseconds: 50));
      expect(bloc.state.extractionReady, isTrue);

      bloc.add(const ChatMessageSent('two'));
      await Future<void>.delayed(const Duration(milliseconds: 50));
      expect(bloc.state.extractionReady, isTrue,
          reason: 'the CTA must not be yanked away mid-flow');
    });

    test('a VOICE turn carries readiness too', () async {
      final ChatBloc bloc = ChatBloc(repo);
      addTearDown(bloc.close);

      bloc.add(const ChatVoiceMerged(
        transcript: 'CNC par chaar saal.',
        reply: 'Bas ho gaya.',
        extractionReady: true,
      ));
      await Future<void>.delayed(const Duration(milliseconds: 30));

      expect(bloc.state.extractionReady, isTrue,
          reason: 'a worker who answers by voice must unlock the same CTA');
    });
  });

  // ----------------------------------------------------------------- opener

  group('chat opener (#422)', () {
    test('the opener is the engine-aligned Hinglish role question', () {
      final ChatBloc bloc = ChatBloc(repo);
      addTearDown(bloc.close);

      final String opener = bloc.state.messages.single.text;
      expect(opener, kChatOpeningText);
      // The engine's FIRST topic is `role` (question_bank.py `_CNC_VMC_TOPICS`),
      // not machines — the old opener asked "Which machines do you run?" and
      // pushed the worker to answer the wrong topic first.
      expect(opener, contains('Aap kaunsa kaam karte hain'));
      expect(opener.toLowerCase(), isNot(contains('which machines')));
      // Persona contract: no vocative is rendered client-side — the
      // "{{worker_name}} ji," slot is filled server-side, and the client holds
      // no name to render here.
      expect(opener, isNot(contains('{{worker_name}}')));
      expect(opener, isNot(contains(' ji,')));
      // B-5: exactly one question per turn.
      expect('?'.allMatches(opener).length, 1);
    });
  });
}
