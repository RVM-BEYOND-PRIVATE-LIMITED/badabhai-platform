import 'package:flutter/material.dart';

/// Voice note capture — PLACEHOLDER. Real recording + upload (≤120s) and Sarvam
/// STT come later. This screen just illustrates the entry point in the flow.
class VoiceNotePlaceholderScreen extends StatelessWidget {
  const VoiceNotePlaceholderScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Voice note')),
      body: Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: <Widget>[
            const Icon(Icons.mic, size: 64),
            const SizedBox(height: 16),
            const Padding(
              padding: EdgeInsets.symmetric(horizontal: 32),
              child: Text(
                'Voice notes (max 120s) are a Phase 1 placeholder. Recording, upload, '
                'and transcription will be added later.',
                textAlign: TextAlign.center,
              ),
            ),
            const SizedBox(height: 24),
            OutlinedButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('Back to chat'),
            ),
          ],
        ),
      ),
    );
  }
}
