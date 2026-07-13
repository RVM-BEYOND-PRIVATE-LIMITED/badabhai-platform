import 'package:equatable/equatable.dart';

/// A row in the interview-kit list (spec §5.3 / `.aw-kitrow`). Points at a
/// per-trade [InterviewKit] via [tradeKey] (a lowercase slug from
/// GET /interview-kits).
class KitListItem extends Equatable {
  const KitListItem({
    required this.tradeKey,
    required this.title,
    required this.subtitle,
  });

  final String tradeKey;
  final String title;
  final String subtitle;

  KitListItem copyWith({
    String? tradeKey,
    String? title,
    String? subtitle,
  }) {
    return KitListItem(
      tradeKey: tradeKey ?? this.tradeKey,
      title: title ?? this.title,
      subtitle: subtitle ?? this.subtitle,
    );
  }

  @override
  List<Object?> get props => <Object?>[tradeKey, title, subtitle];
}

/// The full interview kit for a trade — a per-trade PREP PACK from
/// GET /interview-kits/:tradeKey. It is an overview + four categorized question
/// LISTS (there are NO model answers on the wire — this is a preparation pack,
/// not a Q&A-with-answers set), a skill checklist, revise-before / documents /
/// common-mistakes lists, and a Hinglish note. Mirrors the backend
/// InterviewKitContent shape. PII-free (per-trade, never per-worker).
class InterviewKit extends Equatable {
  const InterviewKit({
    required this.tradeKey,
    required this.title,
    required this.overview,
    required this.commonQuestions,
    required this.practicalQuestions,
    required this.safetyQuestions,
    required this.drawingMeasurementQuestions,
    required this.skillChecklist,
    required this.reviseBefore,
    required this.documentsToCarry,
    required this.commonMistakes,
    required this.hinglishNote,
  });

  final String tradeKey;

  /// Trade display name (`display_name`).
  final String title;
  final String overview;
  final List<String> commonQuestions;
  final List<String> practicalQuestions;
  final List<String> safetyQuestions;
  final List<String> drawingMeasurementQuestions;
  final List<String> skillChecklist;
  final List<String> reviseBefore;
  final List<String> documentsToCarry;
  final List<String> commonMistakes;
  final String hinglishNote;

  @override
  List<Object?> get props => <Object?>[
        tradeKey,
        title,
        overview,
        commonQuestions,
        practicalQuestions,
        safetyQuestions,
        drawingMeasurementQuestions,
        skillChecklist,
        reviseBefore,
        documentsToCarry,
        commonMistakes,
        hinglishNote,
      ];
}
