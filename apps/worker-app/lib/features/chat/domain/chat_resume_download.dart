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
/// The line is HONEST about the PDF: ready ([kChatResumeDownloadReply]), still
/// being made ([kChatResumeDownloadPendingReply] — the tile waits it out), or
/// failed ([kChatResumeDownloadFailedReply], and no tile). Only a worker with
/// no résumé at all is left to the server.
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

/// The answer while the résumé's PDF is STILL BEING MADE (`render_status:
/// pending`). It is not ready, so the line does not say it is — and the tile
/// still helps: a tap waits for the render and saves the PDF when it lands.
const String kChatResumeDownloadPendingReply =
    'Aapka resume abhi ban raha hai. Neeche "Resume download" dabaiye — PDF '
    'taiyaar hote hi isi screen se aapke phone mein save ho jayegi.';

/// The Devanagari twin of [kChatResumeDownloadPendingReply], for read-aloud.
const String kChatResumeDownloadPendingReplyTts =
    'आपका रिज़्यूमे अभी बन रहा है। नीचे "रिज़्यूमे डाउनलोड" दबाइए — पीडीएफ़ '
    'तैयार होते ही इसी स्क्रीन से आपके फ़ोन में सेव हो जाएगी।';

/// The answer when the résumé's PDF render FAILED — no tile, because its
/// download can only answer 409. Word for word the server's own reviewed line
/// for the same state (`RESUME_RENDER_FAILED`, companion-replies.ts), so the
/// worker hears one story whichever side answers; the Resume tab it points at
/// says why, beside a disabled Download.
const String kChatResumeDownloadFailedReply =
    'Aapka resume abhi download nahi ho sakta. Resume tab mein dekhein.';

/// The Devanagari twin of [kChatResumeDownloadFailedReply], for read-aloud.
const String kChatResumeDownloadFailedReplyTts =
    'आपका रिज़्यूमे अभी डाउनलोड नहीं हो सकता। रिज़्यूमे टैब में देखें।';

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

/// HINDI SCRIPT. The composer strips TYPED Devanagari (#1411), but the
/// dictation mic's Send posts the recogniser's text as it came, and a
/// Hindi-locale recogniser writes a spoken "resume dikhao" in Hindi script —
/// so the lists below are how a SPOKEN ask is recognised at all.
///
/// The NOUNS (the résumé, a download, a PDF) are matched as SUBSTRINGS: a
/// matra is a combining mark, not a letter, so the letters-only word split
/// would cut them apart. The ask and guard words are WHOLE TOKENS (split on
/// spaces and punctuation, never on a matra), the twin of the Latin
/// whole-word rule (#2294): as a substring "भेज दो" also matched "भेज दोगे"
/// ("will you send it?"), which is talk.
///
/// A recogniser writes a nukta letter either as the letter plus the nukta
/// sign or as one precomposed code point (U+0958–U+095F), and a substring of
/// one never matches the other — so the text AND every list are put in the
/// first form ([_decomposeNukta]) before anything is compared.
const List<String> _kDownloadDevanagari = <String>['डाउनलोड', 'पीडीएफ'];
const List<String> _kResumeDevanagari = <String>[
  'रिज़्यूम',
  'रिज्यूम',
  'रिज़्युम',
  'रिज्युम',
  'बायोडाटा',
];

/// The Devanagari twins of the imperative show / send words — outright
/// requests, as runs of whole tokens. Never a bare root: "दिखा" alone is also
/// the stem of "दिखाया" ("showed").
const List<List<String>> _kAskDevanagari = <List<String>>[
  <String>['दिखाओ'],
  <String>['दिखाइए'],
  <String>['दिखाइये'],
  <String>['दिखा', 'दो'],
  <String>['दिखा', 'दीजिए'],
  <String>['दिखा', 'दीजिये'],
  <String>['भेज', 'दो'],
  <String>['भेजदो'],
  <String>['भेजिए'],
  <String>['भेजिये'],
  <String>['भेज', 'दीजिए'],
  <String>['भेज', 'दीजिये'],
];

/// "Dekhna hai" and "where is it" in Hindi script: asks only beside the NAMED
/// résumé, like their Latin twins.
const List<List<String>> _kSeeDevanagari = <List<String>>[
  <String>['देखना'],
  <String>['कहाँ'],
  <String>['कहां'],
];

/// The Devanagari twins of [_kInsideWords] (whole tokens) and of
/// [_kChangeStems] (token prefixes, like the Latin stems). Over-matching here
/// only makes the rule stricter — a message is left to the server.
const List<String> _kInsideDevanagari = <String>['में', 'अंदर'];
const List<String> _kChangeDevanagari = <String>[
  'नया',
  'नई',
  'नए',
  'नये',
  'नयी',
  'न्यू',
  'बना',
  'बदल',
  'चेंज',
  'अपडेट',
  'एडिट',
  'ऐड',
  'एड',
  'सुधार',
  'गलत',
  'ग\u093Cलत',
  'जोड',
  'हटा',
  'लिख',
  'डाल',
  'डिलीट',
];

/// Each precomposed nukta letter, and the letter plus nukta sign it is short
/// for.
const Map<String, String> _kPrecomposedNukta = <String, String>{
  '\u0958': '\u0915\u093C',
  '\u0959': '\u0916\u093C',
  '\u095A': '\u0917\u093C',
  '\u095B': '\u091C\u093C',
  '\u095C': '\u0921\u093C',
  '\u095D': '\u0922\u093C',
  '\u095E': '\u092B\u093C',
  '\u095F': '\u092F\u093C',
};

final RegExp _kAnyPrecomposedNukta = RegExp('[\u0958-\u095F]');

/// [text] with every precomposed nukta letter written as letter + nukta sign.
String _decomposeNukta(String text) {
  if (!_kAnyPrecomposedNukta.hasMatch(text)) return text;
  final StringBuffer out = StringBuffer();
  for (final int rune in text.runes) {
    final String ch = String.fromCharCode(rune);
    out.write(_kPrecomposedNukta[ch] ?? ch);
  }
  return out.toString();
}

List<String> _decomposedAll(List<String> words) =>
    words.map(_decomposeNukta).toList(growable: false);

// The Hindi-script lists in the ONE nukta form the text is compared in.
final List<String> _downloadDevanagari = _decomposedAll(_kDownloadDevanagari);
final List<String> _resumeDevanagari = _decomposedAll(_kResumeDevanagari);
final List<List<String>> _askDevanagari = _kAskDevanagari
    .map(_decomposedAll)
    .toList(growable: false);
final List<List<String>> _seeDevanagari = _kSeeDevanagari
    .map(_decomposedAll)
    .toList(growable: false);
final List<String> _insideDevanagari = _decomposedAll(_kInsideDevanagari);
final List<String> _changeDevanagari = _decomposedAll(_kChangeDevanagari);

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

/// Words that ask to SEE or GET the résumé — "resume dikhao / dikhaiye",
/// "resume dekhna hai", "show my resume", "send my cv", "resume print karna
/// hai". WHOLE words, never prefixes (#2291): a prefix also caught the worker
/// TALKING about the résumé — "kya company ne mera resume dekha?", "resume
/// bheja tha", "resume bhejne ke baad kya hoga" — and those questions must
/// reach the server. Never enough alone: "jobs dikhao" is a jobs question, so
/// the message must also name the résumé.
const Set<String> _kShowWords = <String>{
  'dikhao',
  'dikhaao',
  'dikhado',
  'dikhaiye',
  'dikhayiye',
  'dikhaiyega',
  'dikhaye',
  'dikhana',
  'dikhlao',
  'dekhna',
  'dekhni',
  'dekhao',
  'show',
  // The tum-form imperative of "bhej" is left out on purpose: the persona guard
  // bans it as a literal, and "resume bhej do" / "bhejiye" cover the ask.
  'bhejiye',
  'bhejdo',
  'bhejna',
  'send',
  'print',
  'printout',
};

/// A bare root asks only with a "give" word right after it — "resume bhej
/// do", "cv dikha dijiye", "resume dikha sakte ho?". Alone ("resume dekh ke
/// job milegi?") it is talk.
const Set<String> _kShowRoots = <String>{'dikha', 'dikhla', 'dekh', 'bhej'};
const Set<String> _kGiveWords = <String>{
  'do',
  'de',
  'dijiye',
  'dijie',
  'dena',
  'dein',
  'sakte',
  'sakti',
  'sakta',
};

/// The show / send words that are outright REQUESTS — imperatives — and the
/// give words that make a root one ("bhej do", "dikha dijiye"). On an
/// interview these are the only ones that turn a bare "pdf" or "download" into
/// an ask: the ability and infinitive forms ("bhej sakta hoon", "bhejna aata
/// hai"), "send" / "print" and "kahan" are how a worker DESCRIBES a skill.
const Set<String> _kImperativeShowWords = <String>{
  'dikhao',
  'dikhaao',
  'dikhado',
  'dikhaiye',
  'dikhayiye',
  'dikhaiyega',
  'dikhlao',
  'bhejiye',
  'bhejdo',
};
const Set<String> _kImperativeGiveWords = <String>{
  'do',
  'de',
  'dijiye',
  'dijie',
  'dein',
};

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

/// Spaces, punctuation (the danda included) and symbols — never a matra, so a
/// Hindi-script word stays whole.
final RegExp _kSpaceSplit = RegExp(r'[\s\p{P}\p{S}]+', unicode: true);

/// The résumé the tile downloads, and WHICH VERSION of it that is.
class DownloadableResume {
  const DownloadableResume({
    required this.id,
    required this.version,
    this.renderedAt = '',
    this.pending = false,
  });

  /// What `GET /resume/:id/download` is called with.
  final String id;

  /// Its PDF is still being rendered (`render_status: pending`): offered all
  /// the same — a tap waits the render out — but an ask is answered with
  /// [kChatResumeDownloadPendingReply], never "taiyaar hai".
  final bool pending;

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
    pending: current.renderStatus == 'pending',
  );
}

/// Whether [text] asks for the worker's résumé — to download it, or to see or
/// get it ("resume dikhao", "show my resume", "resume bhej do").
///
/// A DOWNLOAD word is enough on the companion, where no question is open. With
/// [requireResumeWord] — an interview, where every typed message is an answer —
/// the message must ALSO name the résumé ("resume download karna hai") or ask
/// for the file with an outright imperative ("pdf bhej do", "pdf dikhao"), so
/// an answer that merely mentions a PDF or a download ("PDF banana aata hai",
/// "pdf bhej sakta hoon") is still posted as one.
///
/// A SHOW / SEND word always needs the résumé named beside it ("jobs dikhao" is
/// a jobs question), and never counts beside a change or new-résumé word ("naya
/// resume bana ke dikhao" is the server's) or an "in the résumé" word ("resume
/// mein welding bhi dikhao" is an edit).
///
/// Pure and deterministic: lowercase, split into words, look the words up.
/// Never logs and never keeps the text.
bool isResumeDownloadRequest(String text, {bool requireResumeWord = false}) {
  final String normalized = _decomposeNukta(text.trim().toLowerCase());
  if (normalized.isEmpty) return false;
  // Latin words (letters only) and WHOLE tokens (split on spaces and
  // punctuation only — what a Hindi-script word is; see [_kAskDevanagari]).
  final List<String> tokens = _splitWords(normalized, _kWordSplit);
  final Set<String> words = tokens.toSet();
  final List<String> spaced = _splitWords(normalized, _kSpaceSplit);
  bool containsAny(List<String> nouns) => nouns.any(normalized.contains);
  bool startsWithAny(Iterable<String> ws, List<String> stems) =>
      ws.any((String w) => stems.any(w.startsWith));
  bool hasRun(List<List<String>> runs) =>
      runs.any((List<String> run) => _containsRun(spaced, run));
  bool rootThenGive(Set<String> gives) {
    for (int i = 0; i + 1 < tokens.length; i++) {
      if (_kShowRoots.contains(tokens[i]) && gives.contains(tokens[i + 1])) {
        return true;
      }
    }
    return false;
  }

  final bool namesResume =
      containsAny(_resumeDevanagari) || words.any(_kResumeWords.contains);
  final bool download =
      containsAny(_downloadDevanagari) || words.any(_kDownloadWords.contains);
  // A message that makes the résumé an edit or a new one is the server's.
  final bool editOrNew =
      startsWithAny(words, _kChangeStems) ||
      startsWithAny(spaced, _changeDevanagari) ||
      words.any(_kInsideWords.contains) ||
      spaced.any(_insideDevanagari.contains);
  // An outright REQUEST for the file — an imperative: "dikhao", "bhej do".
  final bool requests =
      words.any(_kImperativeShowWords.contains) ||
      rootThenGive(_kImperativeGiveWords) ||
      hasRun(_askDevanagari);
  // Every way of asking to see or get it — beside the NAMED résumé only.
  final bool asksToSee =
      requests ||
      words.any(_kShowWords.contains) ||
      words.any(_kWhereWords.contains) ||
      rootThenGive(_kGiveWords) ||
      hasRun(_seeDevanagari);
  if (download) {
    if (!requireResumeWord || namesResume) return true;
    // An interview, and "pdf" / "download" without the résumé named: an ask
    // only beside an outright request. A worker DESCRIBING a skill says "pdf
    // bhej sakta hoon", "pdf bhejna aata hai", "pdf print kar leta hoon" —
    // answers, which must reach the interview.
    return requests && !editOrNew;
  }
  return namesResume && asksToSee && !editOrNew;
}

/// [text] cut at [split], empty pieces dropped.
List<String> _splitWords(String text, RegExp split) =>
    text.split(split).where((String w) => w.isNotEmpty).toList();

/// Whether [run] appears in [tokens] as consecutive whole tokens.
bool _containsRun(List<String> tokens, List<String> run) {
  for (int i = 0; i + run.length <= tokens.length; i++) {
    int j = 0;
    while (j < run.length && tokens[i + j] == run[j]) {
      j++;
    }
    if (j == run.length) return true;
  }
  return false;
}
