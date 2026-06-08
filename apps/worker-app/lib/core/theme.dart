import 'package:flutter/material.dart';

ThemeData buildTheme() {
  return ThemeData(
    useMaterial3: true,
    colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF4F8CFF)),
    appBarTheme: const AppBarTheme(centerTitle: true),
  );
}
