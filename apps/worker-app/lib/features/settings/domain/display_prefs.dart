/// The three display themes the server stores (`light`, `dark`, `system`).
///
/// This is the wire enum, kept free of Flutter so the repository and its tests
/// do not depend on `ThemeMode`. The controller maps it to a `ThemeMode`.
enum DisplayTheme {
  light('light'),
  dark('dark'),
  system('system');

  const DisplayTheme(this.wire);

  /// The exact string the API accepts and returns.
  final String wire;

  /// Reads a wire value defensively: anything unknown (an old server, a typo)
  /// falls back to [light], which is the documented "no preference" answer.
  static DisplayTheme fromWire(Object? value) {
    return switch (value) {
      'dark' => DisplayTheme.dark,
      'system' => DisplayTheme.system,
      _ => DisplayTheme.light,
    };
  }
}

/// One `GET`/`PATCH …/me/display-prefs` reply:
/// `{ "theme": "light" | "dark" | "system", "theme_open": true | false }`.
///
/// When [themeOpen] is false the person must see no choice and stay on Light;
/// the stored [theme] is not an instruction (the API returns `light` anyway
/// while the switch is off).
class DisplayPrefs {
  const DisplayPrefs({required this.theme, required this.themeOpen});

  /// The documented closed/default reply: Light, no choice.
  static const DisplayPrefs closed = DisplayPrefs(
    theme: DisplayTheme.light,
    themeOpen: false,
  );

  final DisplayTheme theme;
  final bool themeOpen;

  factory DisplayPrefs.fromJson(Map<String, dynamic> json) {
    return DisplayPrefs(
      theme: DisplayTheme.fromWire(json['theme']),
      themeOpen: json['theme_open'] == true,
    );
  }

  Map<String, dynamic> toJson() => <String, dynamic>{
    'theme': theme.wire,
    'theme_open': themeOpen,
  };

  @override
  bool operator ==(Object other) {
    return other is DisplayPrefs &&
        other.theme == theme &&
        other.themeOpen == themeOpen;
  }

  @override
  int get hashCode => Object.hash(theme, themeOpen);

  @override
  String toString() => 'DisplayPrefs(theme: ${theme.wire}, open: $themeOpen)';
}
