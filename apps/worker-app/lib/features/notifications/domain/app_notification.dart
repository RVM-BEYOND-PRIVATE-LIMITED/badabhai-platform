import 'package:equatable/equatable.dart';

/// What a notification is about (drives its icon + colour tone in the row). Maps
/// from the API's coarse `type` — never an employer/demand kind (faceless, §2).
enum NotificationKind { resumeReady, profileReady, voiceProcessed, security }

/// One alert row (spec §5.11). PII-FREE by contract: fed from
/// GET /workers/me/notifications, whose copy is faceless server-rendered text —
/// never an employer, pay, name, or phone. `id` is the opaque event id.
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
