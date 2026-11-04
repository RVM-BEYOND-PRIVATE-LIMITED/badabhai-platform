import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

/// Status-bar styling per surface (#2590).
///
/// Only the icon BRIGHTNESS changes per surface; the bar itself is transparent
/// so the surface under it (a deep-blue header, or the light page canvas) shows
/// through. No colour is introduced here — the surfaces keep their own tokens.
///
/// Apply with `AnnotatedRegion<SystemUiOverlayStyle>` around the surface that
/// sits under the status bar; the innermost region wins.
class AppSystemUi {
  AppSystemUi._();

  /// Light status-bar icons — for a deep-blue surface drawn behind the bar
  /// (Home identity header, login brand header).
  static const SystemUiOverlayStyle onDark = SystemUiOverlayStyle(
    statusBarColor: Colors.transparent,
    statusBarIconBrightness: Brightness.light, // Android
    statusBarBrightness: Brightness.dark, // iOS
  );

  /// Dark status-bar icons — for the light page canvas and app bars.
  static const SystemUiOverlayStyle onLight = SystemUiOverlayStyle(
    statusBarColor: Colors.transparent,
    statusBarIconBrightness: Brightness.dark, // Android
    statusBarBrightness: Brightness.light, // iOS
  );
}
