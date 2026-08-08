import 'dart:io';

import 'package:flutter/services.dart' show rootBundle;

/// A resolved read-aloud source for one question, or [TtsNone] when the question
/// has no usable audio and the caller must degrade to text (never on-device
/// Android TTS — an owner ruling).
sealed class TtsSource {
  const TtsSource();
}

/// A prompt shipped in the app bundle (`assets/bb-tts/<key>.mp3`). The fastest,
/// offline-safe source — the packaged corpus for the common questions.
class TtsBundledAsset extends TtsSource {
  const TtsBundledAsset(this.assetPath);
  final String assetPath;
}

/// A prompt previously fetched and cached on disk (temp `bb-tts/<key>.mp3`).
class TtsCachedFile extends TtsSource {
  const TtsCachedFile(this.filePath);
  final String filePath;
}

/// No usable source — the caller reads the question as text and continues. TTS
/// is an enhancement, never a gate.
class TtsNone extends TtsSource {
  const TtsNone();
}

/// Resolves a question's `ttsAssetKey` down the chain **bundled asset → cache →
/// (network, a later rung) → silence** (#631). Network is intentionally omitted
/// until the rendered corpus lands (ai-service A3, blocked on the Sarvam
/// romanized-Hinglish smoke test); the chain degrades to [TtsNone] instead of
/// ever invoking on-device Android TTS.
///
/// The cache lives in a **`bb-tts/` subdirectory** of the temp dir — never as a
/// `bb-voice-*.m4a` file in the temp root — so the recorder's stale-clip sweep
/// (#624) can never reclaim a TTS asset (the sweep is non-recursive and skips
/// directories).
class TtsAssetResolver {
  TtsAssetResolver({
    Future<bool> Function(String assetPath)? assetExists,
    Directory? cacheParent,
  })  : _assetExists = assetExists ?? _rootBundleHas,
        _cacheParent = cacheParent ?? Directory.systemTemp;

  final Future<bool> Function(String assetPath) _assetExists;
  final Directory _cacheParent;

  /// The subdirectory (under the temp dir) where fetched TTS clips are cached.
  /// Public so a test can assert the sweep leaves it intact.
  static const String cacheSubdir = 'bb-tts';

  String _assetPathFor(String key) => 'assets/$cacheSubdir/$key.mp3';

  String cachedPathFor(String key) =>
      '${_cacheParent.path}${Platform.pathSeparator}$cacheSubdir'
      '${Platform.pathSeparator}$key.mp3';

  Future<TtsSource> resolve(String? ttsAssetKey) async {
    final String? key = ttsAssetKey;
    if (key == null || key.isEmpty) return const TtsNone();

    final String asset = _assetPathFor(key);
    if (await _assetExists(asset)) return TtsBundledAsset(asset);

    final String cached = cachedPathFor(key);
    if (await File(cached).exists()) return TtsCachedFile(cached);

    return const TtsNone();
  }

  /// Probes the app bundle for [assetPath] without throwing when it is absent.
  static Future<bool> _rootBundleHas(String assetPath) async {
    try {
      await rootBundle.load(assetPath);
      return true;
    } catch (_) {
      return false;
    }
  }
}
