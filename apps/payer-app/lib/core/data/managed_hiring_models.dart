/// #2751 — Managed Hiring, the slices this app shows: the quote (price and terms) and the
/// order tracker. The APP CONTAINS NO PAYMENT UI: its paid button opens the payer web portal in
/// the external browser, where checkout lives (CLAUDE.md section 12, owner ruling 18 Nov 2026).
library;

class ManagedHiringPrice {
  const ManagedHiringPrice({
    required this.priceInr,
    required this.taxablePaise,
    required this.gstPaise,
    required this.totalPaise,
  });

  final int priceInr;
  final int taxablePaise;
  final int gstPaise;
  final int totalPaise;

  factory ManagedHiringPrice.fromJson(Map<String, dynamic> json) =>
      ManagedHiringPrice(
        priceInr: (json['price_inr'] as num?)?.toInt() ?? 0,
        taxablePaise: (json['taxable_paise'] as num?)?.toInt() ?? 0,
        gstPaise: (json['gst_paise'] as num?)?.toInt() ?? 0,
        totalPaise: (json['total_paise'] as num?)?.toInt() ?? 0,
      );
}

/// `offer: "order"` carries a price and (optionally) an open order; `offer: "callback"` is a
/// job above the largest tier and has no checkout.
class ManagedHiringQuote {
  const ManagedHiringQuote({
    required this.jobPostingId,
    required this.offer,
    required this.terms,
    this.tier,
    this.price,
    this.targetCount,
    this.workingDays,
    this.extensionDays,
    this.openOrderId,
    this.callbackRequestId,
  });

  final String jobPostingId;
  final String offer; // "order" | "callback"
  final String terms;
  final String? tier;
  final ManagedHiringPrice? price;
  final int? targetCount;
  final int? workingDays;
  final int? extensionDays;
  final String? openOrderId;
  final String? callbackRequestId;

  bool get isOrder => offer == 'order';

  factory ManagedHiringQuote.fromJson(Map<String, dynamic> json) {
    final Object? rawPrice = json['price'];
    final Object? openOrder = json['open_order'];
    return ManagedHiringQuote(
      jobPostingId: json['job_posting_id'] as String? ?? '',
      offer: json['offer'] as String? ?? 'callback',
      terms: json['terms'] as String? ?? '',
      tier: json['tier'] as String?,
      price: rawPrice is Map<String, dynamic>
          ? ManagedHiringPrice.fromJson(rawPrice)
          : null,
      targetCount: (json['target_count'] as num?)?.toInt(),
      workingDays: (json['working_days'] as num?)?.toInt(),
      extensionDays: (json['extension_days'] as num?)?.toInt(),
      openOrderId: openOrder is Map<String, dynamic>
          ? openOrder['order_id'] as String?
          : null,
      callbackRequestId: json['callback_request_id'] as String?,
    );
  }
}

class ManagedHiringOrder {
  const ManagedHiringOrder({
    required this.orderId,
    required this.status,
    required this.targetCount,
    required this.confirmedCount,
    required this.dueAt,
    required this.extendedUntil,
  });

  final String orderId;
  final String status;
  final int targetCount;
  final int confirmedCount;
  final String? dueAt;
  final String? extendedUntil;

  factory ManagedHiringOrder.fromJson(Map<String, dynamic> json) =>
      ManagedHiringOrder(
        orderId: json['order_id'] as String? ?? '',
        status: json['status'] as String? ?? '',
        targetCount: (json['target_count'] as num?)?.toInt() ?? 0,
        confirmedCount: (json['confirmed_count'] as num?)?.toInt() ?? 0,
        dueAt: json['due_at'] as String?,
        extendedUntil: json['extended_until'] as String?,
      );
}
