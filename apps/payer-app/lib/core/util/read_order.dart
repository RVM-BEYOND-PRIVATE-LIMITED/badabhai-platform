/// #2592 — orders overlapping reads of ONE list, so an older response can
/// never land over a newer one.
///
/// A screen that keeps its rows on screen while it re-reads can have two reads
/// of the same list in flight: a quiet refresh (a return to the tab, a pull)
/// and the re-read after an action (a pause, a close). Whichever was SENT
/// later carries the newer server state, so:
///
///  - a response is shown only when it is newer than the one on screen
///    ([claim]) — the refresh sent before a pause can never put the pre-pause
///    list back after the post-pause one landed;
///  - a failure is reported only by the newest read ([isLatest]) — an older
///    read failing says nothing about a newer one still on its way;
///  - a failure the screen SHOWS (an error state) takes the newest read's
///    place on screen ([settle]) — an older read landing after it is dropped
///    instead of repainting the list from before the action over the error.
class ReadOrder {
  int _issued = 0;
  int _shown = 0;

  /// Starts a read; the returned ticket goes to [claim] / [isLatest] /
  /// [settle].
  int start() => ++_issued;

  /// True — and [ticket] becomes the one on screen — when its response is
  /// newer than the one already shown. False: drop it.
  bool claim(int ticket) {
    if (ticket <= _shown) return false;
    _shown = ticket;
    return true;
  }

  /// True when no read was started after [ticket].
  bool isLatest(int ticket) => ticket == _issued;

  /// [ticket] failed and the screen now shows that failure: from here on only
  /// a read started after it may land.
  void settle(int ticket) {
    if (ticket > _shown) _shown = ticket;
  }
}
