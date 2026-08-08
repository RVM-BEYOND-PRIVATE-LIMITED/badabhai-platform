/// The two parallel profiling paths (#638, owner ruling: alternate paths, both
/// writing the SAME profile).
enum ProfilingPath {
  /// The existing LLM chat — always available, never removed.
  chat,

  /// The voice-driven profiling form (#627–#639).
  voiceForm,
}

/// What the app should do at the profiling entry point.
sealed class ProfilingEntry {
  const ProfilingEntry();
}

/// Only one path is available — go straight to it, never show a one-option
/// chooser.
class ProfilingGoDirect extends ProfilingEntry {
  const ProfilingGoDirect(this.path);
  final ProfilingPath path;
}

/// Two paths are available — let the worker pick.
class ProfilingShowChooser extends ProfilingEntry {
  const ProfilingShowChooser(this.paths);
  final List<ProfilingPath> paths;
}

/// Decide the profiling entry (#638). Chat is ALWAYS available; the voice form is
/// available only when the kill switch is off. The chooser is shown ONLY when
/// both exist:
///  - kill switch ON  → only chat → [ProfilingGoDirect] to chat (exactly today's
///    behavior, so shipping dark changes nothing).
///  - kill switch OFF → chat + voice form → [ProfilingShowChooser].
///
/// A one-option chooser is never returned, by construction.
ProfilingEntry resolveProfilingEntry({required bool voiceFormHidden}) {
  final List<ProfilingPath> paths = <ProfilingPath>[
    ProfilingPath.chat,
    if (!voiceFormHidden) ProfilingPath.voiceForm,
  ];
  if (paths.length < 2) return ProfilingGoDirect(paths.single);
  return ProfilingShowChooser(paths);
}
