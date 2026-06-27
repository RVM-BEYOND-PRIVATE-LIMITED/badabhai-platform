import 'package:equatable/equatable.dart';

/// What a notification is about (drives its icon + colour tone in the row).
enum NotificationKind { newJob, profileViewed, resumeReady }

/// One alert row (spec §5.11). PII-free: mock employer names are fabricated
/// display strings, never real PII; ids are mock-* sentinels.
class AppNotification extends Equatable {
  const AppNotification({
    required this.id,
    required this.kind,
    required this.title,
    required this.subtitle,
    required this.time,
    this.read = false,
  });

  final String id;
  final NotificationKind kind;
  final String title;
  final String subtitle;
  final String time;
  final bool read;

  AppNotification copyWith({bool? read}) {
    return AppNotification(
      id: id,
      kind: kind,
      title: title,
      subtitle: subtitle,
      time: time,
      read: read ?? this.read,
    );
  }

  @override
  List<Object?> get props =>
      <Object?>[id, kind, title, subtitle, time, read];
}
