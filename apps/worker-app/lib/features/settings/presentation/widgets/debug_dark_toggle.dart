import 'package:flutter/foundation.dart' show kReleaseMode;
import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/di/locator.dart';
import '../../../../core/theme/theme_cubit.dart';
import '../../../../core/widgets/bb_list_row.dart';

/// Debug-only preview of the ink theme (#2824 item 8).
///
/// It is compiled in only as a guard: in a release build the widget renders
/// nothing, and [ThemeCubit.debugSetDark] refuses to change state. It never
/// appears for a worker.
class DebugDarkToggleRow extends StatelessWidget {
  const DebugDarkToggleRow({super.key});

  @override
  Widget build(BuildContext context) {
    if (kReleaseMode) return const SizedBox.shrink();
    if (!locator.isRegistered<ThemeCubit>()) return const SizedBox.shrink();
    final ThemeCubit cubit = locator<ThemeCubit>();
    return BlocBuilder<ThemeCubit, ThemeState>(
      bloc: cubit,
      builder: (BuildContext context, ThemeState state) => BbListRow.toggle(
        icon: Icons.brightness_6_outlined,
        title: 'DEVELOPER · ink preview',
        subtitle: 'Debug builds only',
        value: state.debugDark,
        onChanged: cubit.debugSetDark,
      ),
    );
  }
}
