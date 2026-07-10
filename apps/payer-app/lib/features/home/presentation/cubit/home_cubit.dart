import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/data/models.dart';
import '../../../../core/data/payer_api_client.dart';

/// Loads the Home dashboard: demand metrics, recent activity, and (for an
/// agency session) the Earn·Supply summary. The credit balance comes from the
/// shared [CreditsCubit], not here, so it stays consistent across screens.
class HomeCubit extends Cubit<HomeState> {
  HomeCubit(this._api) : super(const HomeState());

  final PayerApiClient _api;

  Future<void> load({required bool agency}) async {
    emit(state.copyWith(status: HomeStatus.loading));
    try {
      final HomeMetrics metrics = await _api.fetchHomeMetrics();
      final List<ActivityItem> activity = await _api.fetchRecentActivity();
      final EarnSummary? earn = agency ? await _api.fetchEarnSummary() : null;
      emit(
        HomeState(
          status: HomeStatus.ready,
          metrics: metrics,
          activity: activity,
          earn: earn,
        ),
      );
    } catch (_) {
      emit(state.copyWith(status: HomeStatus.error));
    }
  }
}

enum HomeStatus { initial, loading, ready, error }

class HomeState extends Equatable {
  const HomeState({
    this.status = HomeStatus.initial,
    this.metrics,
    this.activity = const <ActivityItem>[],
    this.earn,
  });

  final HomeStatus status;
  final HomeMetrics? metrics;
  final List<ActivityItem> activity;
  final EarnSummary? earn;

  HomeState copyWith({
    HomeStatus? status,
    HomeMetrics? metrics,
    List<ActivityItem>? activity,
    EarnSummary? earn,
  }) {
    return HomeState(
      status: status ?? this.status,
      metrics: metrics ?? this.metrics,
      activity: activity ?? this.activity,
      earn: earn ?? this.earn,
    );
  }

  @override
  List<Object?> get props => <Object?>[status, metrics, activity, earn];
}
