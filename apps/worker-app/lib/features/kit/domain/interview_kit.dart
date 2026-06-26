import 'package:equatable/equatable.dart';

/// A row in the interview-kit list (spec §5.3 / `.aw-kitrow`). Points at a
/// per-trade [InterviewKit] via [tradeKey].
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

/// One interview question paired with its model answer (spec §5.4 / `.aw-q`).
class KitQa extends Equatable {
  const KitQa({required this.question, required this.answer});

  final String question;
  final String answer;

  KitQa copyWith({String? question, String? answer}) {
    return KitQa(
      question: question ?? this.question,
      answer: answer ?? this.answer,
    );
  }

  @override
  List<Object?> get props => <Object?>[question, answer];
}

/// The full interview kit for a trade — its title and ordered Q&A (spec §5.4).
class InterviewKit extends Equatable {
  const InterviewKit({
    required this.tradeKey,
    required this.title,
    required this.qas,
  });

  final String tradeKey;
  final String title;
  final List<KitQa> qas;

  InterviewKit copyWith({
    String? tradeKey,
    String? title,
    List<KitQa>? qas,
  }) {
    return InterviewKit(
      tradeKey: tradeKey ?? this.tradeKey,
      title: title ?? this.title,
      qas: qas ?? this.qas,
    );
  }

  @override
  List<Object?> get props => <Object?>[tradeKey, title, qas];
}
