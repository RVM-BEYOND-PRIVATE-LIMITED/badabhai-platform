/// The Bada Bhai tab's in-chat résumé download (owner ask, 2026-10-14).
///
/// A tile with ONE button — "Resume download" — that saves the worker's current
/// résumé PDF straight into the phone's Downloads, the worker never leaving the
/// chat.
///
/// WHEN IT IS SHOWN — exactly three cases (owner ruling, 2026-10-15):
///   1. the worker's first visit to the chat after their first profiling;
///   2. their résumé CHANGED — an edit, or a new résumé — since it was last
///      offered ([isUnofferedResume] over [DownloadableResume.token], persisted
///      on the phone by `ResumeDownloadOfferStore`);
///   3. they ASK for it — "mujhe mera resume download karna hai", "resume
///      dikhao", "show my resume" ([isResumeDownloadRequest]), or the server's
///      own download chip.
/// Any other open of the chat stays quiet, and the tile is put away the moment
/// the conversation moves on.
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
/// DELIBERATELY NARROW. "Resume chahiye" or "resume update" are left to the
/// server: on the companion they are a new résumé or an edit, and stealing them
/// here would answer the wrong question.
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

/// Word STEMS that ask to SEE or GET the résumé — "resume dikhao / dikhaiye",
/// "resume dekhna hai", "show my resume", "resume bhej do", "send my cv",
/// "resume print karna hai". Matched as word PREFIXES, so every ending a worker
/// types is covered. Never enough alone: "jobs dikhao" is a jobs question, so
/// the message must also name the résumé.
const List<String> _kShowStems = <String>[
  'dikha',
  'dikhla',
  'dekh',
  'show',
  'bhej',
  'send',
  'print',
];

/// "Where is my résumé" — whole words, read like a show stem. Not "kaha": it
/// is also "said" ("maine kaha tha resume mein…").
const Set<String> _kWhereWords = <String>{'kahan', 'kidhar', 'where'};

/// "IN the résumé" — "resume mein welding bhi dikhao" asks for something to be
/// shown ON the résumé, an edit, not for the file. A show stem beside one of
/// these is not an ask. Not "me": "show me my resume" is.
const Set<String> _kInsideWords = <String>{'mein', 'mei', 'andar'};

/// Word STEMS that make a résumé message a change or a NEW résumé — "naya
/// resume bana ke dikhao", "resume badal ke bhejo". Those belong to the server's
/// edit / new-résumé flows, so a show stem beside one of these is not an ask.
/// A download word still is ("naya resume download karna hai").
const List<String> _kChangeStems = <String>[
  'naya',
  'nayi',
  'new',
  'bana',
  'badal',
  'badl',
  'update',
  'edit',
  'sudhar',
  'change',
  'galat',
  'hata',
  'jod',
  'add',
  'daal',
  'likh',
  'delete',
];

final RegExp _kWordSplit = RegExp(r'[^\p{L}\p{N}]+', unicode: true);

/// The résumé the tile downloads, and WHICH VERSION of it that is.
class DownloadableResume {
  const DownloadableResume({
    required this.id,
    required this.version,
    this.renderedAt = '',
  });

  /// What `GET /resume/:id/download` is called with.
  final String id;

  /// `<id>@<generated_at>` — changes when the worker gets a NEW résumé (a new
  /// row, or a re-generated one: every generate stamps `generated_at`).
  final String version;

  /// When its PDF last finished rendering, or '' while pending / unknown. A
  /// Resume Edit of the name, photo or night shift re-renders the PDF WITHOUT
  /// re-generating it, and this stamp is the only thing that moves.
  final String renderedAt;

  /// What the offer store records: the version and the render stamp.
  String get token => '$version#$renderedAt';
}

/// Whether [current] is a résumé the tile has NOT been offered for yet, given
/// the [offered] token the store holds (case 1: nothing offered; case 2: it
/// changed since).
///
/// "Changed" is a new or re-generated résumé, or the SAME résumé re-rendered
/// (a Resume Edit) — but only when both render stamps are known: a pending
/// render that merely finishes is the résumé that was offered, not a new one.
bool isUnofferedResume(String? offered, DownloadableResume current) {
  if (offered == null || offered.isEmpty) return true;
  final int cut = offered.lastIndexOf('#');
  final String offeredVersion = cut < 0 ? offered : offered.substring(0, cut);
  final String offeredRender = cut < 0 ? '' : offered.substring(cut + 1);
  if (offeredVersion != current.version) return true;
  return offeredRender.isNotEmpty &&
      current.renderedAt.isNotEmpty &&
      offeredRender != current.renderedAt;
}

/// The résumé the tile downloads: the row the server marks CURRENT in
/// `GET /resume/history`, or null when there is none to hand over.
///
/// A render that FAILED offers nothing — its download answers 409 "not
/// available" every time, and a button that can only fail is worse than no
/// button. A render still in progress IS offered: the tile waits it out the way
/// the Resume tab's Download does.
DownloadableResume? downloadableResumeIn(ResumeHistory history) {
  final ResumeHistoryItem? current = history.current;
  if (current == null || current.resumeId.isEmpty) return null;
  if (current.hasFailedRender) return null;
  final String generatedAt =
      current.generatedAt?.toUtc().toIso8601String() ?? '';
  return DownloadableResume(
    id: current.resumeId,
    version: '${current.resumeId}@$generatedAt',
    renderedAt: current.renderedAt?.toUtc().toIso8601String() ?? '',
  );
}

/// Whether [text] asks for the worker's résumé — to download it, or to see or
/// get it ("resume dikhao", "show my resume", "resume bhej do").
///
/// A DOWNLOAD word is enough on the companion, where no question is open. With
/// [requireResumeWord] — an interview, where every typed message is an answer —
/// the message must ALSO name the résumé ("resume download karna hai"), so an
/// answer that merely mentions a PDF or a download is still posted as one.
///
/// A SHOW / SEND word always needs the résumé named beside it ("jobs dikhao" is
/// a jobs question), and never counts beside a change or new-résumé word ("naya
/// resume bana ke dikhao" is the server's) or an "in the résumé" word ("resume
/// mein welding bhi dikhao" is an edit).
///
/// Pure and deterministic: lowercase, split into words, look the words up.
/// Never logs and never keeps the text.
bool isResumeDownloadRequest(String text, {bool requireResumeWord = false}) {
  final String normalized = text.trim().toLowerCase();
  if (normalized.isEmpty) return false;
  final Set<String> words = normalized
      .split(_kWordSplit)
      .where((String w) => w.isNotEmpty)
      .toSet();
  final bool namesResume =
      _kResumeDevanagari.any(normalized.contains) ||
      words.any(_kResumeWords.contains);
  final bool download =
      _kDownloadDevanagari.any(normalized.contains) ||
      words.any(_kDownloadWords.contains);
  if (download) return !requireResumeWord || namesResume;
  if (!namesResume) return false;
  bool startsWithAny(List<String> stems) => words.any(
    (String w) => stems.any((String stem) => w.startsWith(stem)),
  );
  final bool asksToSee =
      startsWithAny(_kShowStems) || words.any(_kWhereWords.contains);
  return asksToSee &&
      !startsWithAny(_kChangeStems) &&
      !words.any(_kInsideWords.contains);
}
