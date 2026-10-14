/// The Bada Bhai tab's in-chat résumé download (owner ask, 2026-10-14).
///
/// A tile with ONE button — "Resume download" — that saves the worker's current
/// résumé PDF straight into the phone's Downloads, the worker never leaving the
/// chat. It is offered when the tab opens, put away once the conversation moves
/// on, and offered again whenever the worker asks for their résumé
/// ("mujhe mera resume download karna hai").
///
/// THE ASK IS ANSWERED ON THE PHONE, NEVER POSTED. A download request is not an
/// interview answer and not a companion question: posted mid-interview it would
/// be captured as the answer to whatever question is open, and posted to the
/// companion it would be answered as a résumé question — the recap, or the edit
/// flow ("Resume mein kya badalna hai?") — neither of which hands over the file.
/// So the app recognises it deterministically ([isResumeDownloadRequest]),
/// answers it with a fixed local line and the tile, and sends nothing. The
/// business action itself — minting the signed PDF url — is still the server's:
/// `GET /resume/:id/download` checks ownership and emits `resume.downloaded`.
///
/// No model is involved anywhere here: the recognition is a closed word list.
library;

import '../../../core/api/api_models.dart' show ResumeHistory, ResumeHistoryItem;

/// The tile's button. The owner's own words.
const String kChatResumeDownloadButtonLabel = 'Resume download';

/// The tile's one line of copy, above the button.
const String kChatResumeDownloadTileText =
    'Apna resume PDF mein seedha phone par save karein.';

/// Bada Bhai's local answer to a download request. Points at the button rather
/// than claiming a download has started — nothing has, until the worker taps.
const String kChatResumeDownloadReply =
    'Aapka resume taiyaar hai. Neeche "Resume download" dabaiye — PDF isi '
    'screen se aapke phone mein save ho jayegi.';

/// The Devanagari twin of [kChatResumeDownloadReply] for read-aloud (#896): a
/// hi-IN voice reads romanized Hindi as gibberish, so a speakable local line
/// carries its own script, exactly like the canned opener.
const String kChatResumeDownloadReplyTts =
    'आपका रिज़्यूमे तैयार है। नीचे "रिज़्यूमे डाउनलोड" दबाइए — पीडीएफ़ इसी '
    'स्क्रीन से आपके फ़ोन में सेव हो जाएगी।';

/// The words that make a message a download request, lowercased and matched as
/// WHOLE words: "download" and the spellings a worker types for it, plus "pdf"
/// (the résumé is the only PDF this chat can hand over).
///
/// DELIBERATELY NARROW. "Resume chahiye", "resume bhejo" or "resume update"
/// are left to the server: on the companion they are a new résumé or an edit,
/// and stealing them here would answer the wrong question.
const Set<String> _kDownloadWords = <String>{
  'download',
  'downloads',
  'downloading',
  'downlod',
  'downlaod',
  'donwload',
  'donload',
  'dounload',
  'dawnload',
  'dawnlod',
  'daunload',
  'daunlod',
  'dwnld',
  'pdf',
};

/// Devanagari spellings, matched as SUBSTRINGS: a matra is a combining mark,
/// not a letter, so a letters-only word split would cut these apart. The
/// composer strips Devanagari today (#1411); these keep the rule honest if a
/// dictated or pasted message ever reaches the bloc anyway.
const List<String> _kDownloadDevanagari = <String>['डाउनलोड', 'पीडीएफ'];
const List<String> _kResumeDevanagari = <String>[
  'रिज़्यूमे',
  'रिज्यूमे',
  'बायोडाटा',
];

/// The words that name the résumé itself, for [isResumeDownloadRequest]'s
/// stricter reading (an open interview, where "PDF banana aata hai" is an
/// answer about a skill, not a request).
const Set<String> _kResumeWords = <String>{
  'resume',
  'résumé',
  'cv',
  'biodata',
  'rejume',
  'rezume',
  'rizume',
  'resyume',
};

final RegExp _kWordSplit = RegExp(r'[^\p{L}\p{N}]+', unicode: true);

/// The résumé the tile downloads: the row the server marks CURRENT in
/// `GET /resume/history`, or null when there is none to hand over.
///
/// A render that FAILED offers nothing — its download answers 409 "not
/// available" every time, and a button that can only fail is worse than no
/// button. A render still in progress IS offered: the tile waits it out the way
/// the Resume tab's Download does.
String? downloadableResumeIdIn(ResumeHistory history) {
  final ResumeHistoryItem? current = history.current;
  if (current == null || current.resumeId.isEmpty) return null;
  if (current.hasFailedRender) return null;
  return current.resumeId;
}

/// Whether [text] asks for the worker's résumé to be downloaded.
///
/// A download word is enough on the companion, where no question is open. With
/// [requireResumeWord] — an interview, where every typed message is an answer —
/// the message must ALSO name the résumé ("resume download karna hai"), so an
/// answer that merely mentions a PDF or a download is still posted as one.
///
/// Pure and deterministic: lowercase, split into words, look the words up.
/// Never logs and never keeps the text.
bool isResumeDownloadRequest(String text, {bool requireResumeWord = false}) {
  final String normalized = text.trim().toLowerCase();
  if (normalized.isEmpty) return false;
  final Set<String> words = normalized.split(_kWordSplit).toSet();
  final bool download =
      _kDownloadDevanagari.any(normalized.contains) ||
      words.any(_kDownloadWords.contains);
  if (!download) return false;
  if (!requireResumeWord) return true;
  return _kResumeDevanagari.any(normalized.contains) ||
      words.any(_kResumeWords.contains);
}
