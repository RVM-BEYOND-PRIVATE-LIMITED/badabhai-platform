import '../../../core/api/api_models.dart' show ChatOption;

/// Joins the ticked labels of a `multi_select` chat turn (#1559 / #1583).
///
/// A comma and a space: "Hindi, Marathi" reads like a worker's own answer in
/// the transcript bubble.
const String kChatMultiSelectSeparator = ', ';

/// The ONE message a `multi_select` turn's "Ho gaya" sends, or `''` when
/// nothing usable is ticked.
///
/// WHY LABELS, JOINED, IN ONE MESSAGE. `POST /chat/message` carries only
/// `{session_id, text}` — there is no field for option keys, and the server
/// never reads a key back. It reads the worker's TEXT: a message equal to one
/// chip label is that chip (a list of one), and otherwise every chip label the
/// text CONTAINS is captured, in the order it appears (`matchOptions` in
/// `apps/api/src/profiling/answer-capture.ts`). So the ticked labels, verbatim
/// and in tick order, are exactly what the server already parses — the same
/// words a worker who typed "Hindi, Marathi" would have sent.
///
/// [tickedKeys] are [ChatOption.optionKey]s in the order the worker ticked
/// them. A key that is not among [options] is skipped, never guessed at.
String chatMultiSelectAnswer({
  required List<ChatOption> options,
  required List<String> tickedKeys,
}) {
  final Map<String, String> labelByKey = <String, String>{
    for (final ChatOption o in options) o.optionKey: o.labelText,
  };
  return <String>[
    for (final String key in tickedKeys)
      if ((labelByKey[key] ?? '').trim().isNotEmpty) labelByKey[key]!.trim(),
  ].join(kChatMultiSelectSeparator);
}
