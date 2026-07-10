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
  });

  final String name;
  final String plan;
  final String initials;

  @override
  List<Object?> get props => <Object?>[name, plan, initials];
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
