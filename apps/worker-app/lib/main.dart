import 'package:flutter/material.dart';

import 'app.dart';
import 'core/di/locator.dart';

void main() {
  // Wire the dependency graph once before the app starts. (Widget tests that
  // pump BadaBhaiApp directly don't call this — Splash is DI-free.)
  setupLocator();
  runApp(const BadaBhaiApp());
}
