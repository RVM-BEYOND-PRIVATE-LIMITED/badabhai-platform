import 'package:equatable/equatable.dart';

/// The account type chosen ONCE at login. It fixes the whole session — there is
/// no in-app role switch (see the Payer App kit README "session model").
///
///  - [company] — demand only (hire): Home · Find · Jobs · Credits · Account.
///  - [agency]  — demand + supply: Home · Find · Jobs · **Earn** · Account, and
///    the saffron Earn·Supply summary on Home.
enum PayerRole { company, agency }

extension PayerRoleX on PayerRole {
  bool get isAgency => this == PayerRole.agency;
  String get wire => name; // 'company' | 'agency' — stable for API binding.
}

/// The signed-in payer identity shown in the Home header / Account card.
/// PII-free at this layer: a display name, a plan label, and the initials the
/// avatar renders (no phone, no employer document tokens).
class PayerAccount extends Equatable {
  const PayerAccount({
    required this.name,
    required this.plan,
    required this.initials,
    this.postingOrgName,
  });

  final String name;
  final String plan;
  final String initials;

  /// ADR-0053 O-10 (#2194) — the org a POSTING this account publishes goes out
  /// under, which is not always [name]: [name] is the person's own account
  /// label, while a team member with tenancy on publishes under the founder's
  /// company. Null when the API does not send it (older build) or tenancy
  /// refuses the payer; the posting form then falls back to [name], exactly as
  /// before the field existed.
  final String? postingOrgName;

  @override
  List<Object?> get props => <Object?>[name, plan, initials, postingOrgName];
}

/// #2194 (ADR-0053 O-10) — the org label a POSTING this account publishes must
/// carry.
///
/// [PayerAccount.postingOrgName] when the server sent one, else the account's
/// own [PayerAccount.name]. The fallback covers both an older API that does not
/// send the field and a `null` meaning tenancy refuses this payer — in which
/// case the server refuses the create itself, so the label never reaches a
/// posting. A signed-out caller gets an empty string, exactly as before.
String postingOrgLabelFor(PayerAccount? account) {
  final String? tenantName = account?.postingOrgName?.trim();
  if (tenantName != null && tenantName.isNotEmpty) return tenantName;
  return account?.name ?? '';
}

/// The active session: the locked [role] + the resolved [account] identity.
/// Held by [AppSessionCubit]; `null` means "not signed in" (show Login).
class AppSession extends Equatable {
  const AppSession({required this.role, required this.account});

  final PayerRole role;
  final PayerAccount account;

  bool get isAgency => role.isAgency;

  @override
  List<Object?> get props => <Object?>[role, account];
}
