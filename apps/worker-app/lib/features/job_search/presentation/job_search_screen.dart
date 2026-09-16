import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../core/di/locator.dart';
import '../../../core/error/failure_reason.dart';
import '../../../core/theme/onboarding_theme.dart';
import '../../../core/util/job_display.dart';
import '../../../core/util/pay_format.dart';
import '../../../core/widgets/bb_job_card.dart';
import '../../../core/widgets/bb_spinner.dart';
import '../../../core/widgets/bb_status_view.dart';
import '../../../core/widgets/kit/kit_content_column.dart';
import '../../../core/widgets/onboarding/primary_action_button.dart';
import '../../../router.dart';
import '../../swipe/domain/job_detail.dart';
import '../domain/job_search_item.dart';
import 'cubit/job_search_cubit.dart';
import 'cubit/job_search_state.dart';
import '../../../core/util/push_once.dart';
import '../../../core/widgets/feedback_fab.dart';

/// The Indeed-style job SEARCH screen: a worker types a title/skill ("CNC
/// operator") and a location ("Kota, Rajasthan") and sees matching OPEN jobs.
///
/// The search + location inputs live in a navy [SliverAppBar] (`floating` +
/// `snap`), so the whole "What / Where" bar HIDES when the worker scrolls the
/// results down and REAPPEARS on scroll up — the required Indeed interaction,
/// done natively by the sliver rather than a bespoke scroll listener. The app
/// title and back button stay pinned above it.
///
/// All business logic (matching, ranking, paging boundaries) is the backend's;
/// this screen renders [JobSearchState] and dispatches to [JobSearchCubit].
/// Results reuse [BbJobCard] and open the shared job-detail route the exact same
/// way the feed does.
class JobSearchScreen extends StatelessWidget {
  const JobSearchScreen({super.key, this.cubit});

  /// Test seam: inject a [JobSearchCubit] over a real repository + MockClient.
  final JobSearchCubit? cubit;

  @override
  Widget build(BuildContext context) {
    final JobSearchCubit? injected = cubit;
    if (injected != null) {
      return BlocProvider<JobSearchCubit>.value(
        value: injected,
        child: const _JobSearchView(),
      );
    }
    return BlocProvider<JobSearchCubit>(
      create: (_) => locator<JobSearchCubit>(),
      child: const _JobSearchView(),
    );
  }
}

class _JobSearchView extends StatefulWidget {
  const _JobSearchView();

  @override
  State<_JobSearchView> createState() => _JobSearchViewState();
}

class _JobSearchViewState extends State<_JobSearchView> {
  final TextEditingController _titleController = TextEditingController();
  final TextEditingController _locationController = TextEditingController();
  final ScrollController _scrollController = ScrollController();

  /// The spec §3.2 input height at 100% font. The collapsing header has a FIXED
  /// expanded height, so the form's geometry has to be computable rather than
  /// intrinsic — see [_formHeight].
  static const double _baseFieldHeight = 54;

  /// Everything in the form that does NOT scale with the font: the top pad (8),
  /// the gap between the fields (8), the gap above the button (12), the bottom
  /// pad (12) and 4 of slack, so a sub-pixel rounding inside the collapsing
  /// header can never overflow.
  static const double _formChrome = 44;

  /// Distance from the bottom at which the next page is prefetched.
  static const double _loadMoreThreshold = 480;

  /// The font scale the form is drawn at: the worker's own, clamped like every
  /// other piece of chrome. The fields are inside a fixed-height sliver, so an
  /// unclamped 2.0 would clip the very text it was meant to enlarge; the results
  /// below are NOT clamped and scale the whole way.
  double _scale(BuildContext context) =>
      MediaQuery.textScalerOf(context)
          .scale(_baseFieldHeight)
          .clamp(
            _baseFieldHeight,
            _baseFieldHeight * OnboardingLayout.chromeMaxTextScale,
          ) /
      _baseFieldHeight;

  double _fieldHeight(double scale) => _baseFieldHeight * scale;

  /// The search form's own height (below the pinned toolbar), grown by the
  /// clamped font scale so a large system font enlarges the fields instead of
  /// clipping inside them.
  double _formHeight(double scale) =>
      _formChrome + 2 * _fieldHeight(scale) + OnboardingLayout.buttonHeight;

  @override
  void initState() {
    super.initState();
    _scrollController.addListener(_onScroll);
  }

  @override
  void dispose() {
    _scrollController
      ..removeListener(_onScroll)
      ..dispose();
    _titleController.dispose();
    _locationController.dispose();
    super.dispose();
  }

  void _onScroll() {
    if (!_scrollController.hasClients) return;
    final ScrollPosition pos = _scrollController.position;
    if (pos.pixels >= pos.maxScrollExtent - _loadMoreThreshold) {
      // A no-op unless the cubit is showing results with more pages and nothing
      // in flight — safe to call on every scroll tick.
      context.read<JobSearchCubit>().loadMore();
    }
  }

  void _submit() {
    final JobSearchCubit cubit = context.read<JobSearchCubit>();
    // Already fetching a page (fresh search OR load-more) — ignore the re-submit
    // so a mid-page tap can't fire an overlapping query.
    if (cubit.state.isBusy) return;
    final String title = _titleController.text.trim();
    final String location = _locationController.text.trim();
    // Nothing to search — keep the idle prompt rather than firing a blank query.
    if (title.isEmpty && location.isEmpty) {
      FocusScope.of(context).unfocus();
      return;
    }
    FocusScope.of(context).unfocus();
    cubit.search(title: title, location: location);
  }

  /// Open the full posting, handing over the light [JobDetail] the result row
  /// already holds — the SAME contract the feed uses (the detail route's
  /// redirect requires a [JobDetail] as `extra`). No queue to prune here, so the
  /// pop result is ignored.
  void _openDetail(JobSearchItem item) {
    context.pushOnce(
      '${Routes.jobDetail}/${item.jobId}',
      extra: JobDetail(
        jobId: item.jobId,
        title: item.title,
        city: item.city,
        area: item.area,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: OnboardingColors.canvasBg,
      body: BlocBuilder<JobSearchCubit, JobSearchState>(
        builder: (BuildContext context, JobSearchState state) {
          final double topInset = MediaQuery.paddingOf(context).top;
          return CustomScrollView(
            controller: _scrollController,
            slivers: <Widget>[
              _searchAppBar(context, state, topInset),
              _content(context, state),
            ],
          );
        },
      ),
    );
  }

  /// The navy [SliverAppBar]: a pinned toolbar (title + back) with the
  /// "What / Where" form as its flexible content. `floating` + `snap` give the
  /// Indeed hide-on-scroll-down / reveal-on-scroll-up behaviour for free.
  Widget _searchAppBar(
    BuildContext context,
    JobSearchState state,
    double topInset,
  ) {
    final double scale = _scale(context);
    return SliverAppBar(
      pinned: true,
      floating: true,
      snap: true,
      elevation: 0,
      scrolledUnderElevation: 0,
      backgroundColor: OnboardingColors.shiftBlue,
      foregroundColor: OnboardingColors.textOnBlue,
      systemOverlayStyle: SystemUiOverlayStyle.light,
      toolbarHeight: kToolbarHeight,
      collapsedHeight: kToolbarHeight,
      // Put the back arrow and the title on the SAME geometry the app's other
      // one-row navy header uses (a 48dp arrow box on the 16dp gutter, then the
      // title): Material's defaults (56 + 16) indented this title 8dp further
      // than every other pushed screen.
      leadingWidth: OnboardingLayout.tapTarget,
      expandedHeight: kToolbarHeight + topInset + _formHeight(scale),
      leading: IconButton(
        tooltip: 'Wapas',
        onPressed: () => Navigator.of(context).maybePop(),
        icon: const Icon(
          Icons.arrow_back_rounded,
          size: 22,
          color: OnboardingColors.textOnBlue,
        ),
      ),
      titleTextStyle: OnboardingTypography.anek(
        size: 20,
        weight: FontWeight.w800,
        color: OnboardingColors.textOnBlue,
      ),
      title: const Text('Jobs dhoondein'),
      flexibleSpace: FlexibleSpaceBar(
        background: _searchForm(state, topInset, scale),
      ),
    );
  }

  /// The two stacked inputs + Search button, sitting BELOW the pinned toolbar
  /// inside the flexible space. Sized to [_formHeight] exactly.
  Widget _searchForm(JobSearchState state, double topInset, double scale) {
    return MediaQuery.withClampedTextScaling(
      maxScaleFactor: OnboardingLayout.chromeMaxTextScale,
      child: Container(
        color: OnboardingColors.shiftBlue,
        child: Column(
          children: <Widget>[
            // Clear the pinned toolbar (title + back) drawn on top of us.
            SizedBox(height: kToolbarHeight + topInset),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
              child: KitContentColumn(
                maxWidth: OnboardingLayout.maxContentWidth,
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: <Widget>[
                    _field(
                      fieldKey: const Key('jobSearchTitleField'),
                      controller: _titleController,
                      label: 'Job title ya skill',
                      hint: 'Job title ya skill — jaise CNC operator',
                      icon: Icons.work_outline_rounded,
                      action: TextInputAction.next,
                      height: _fieldHeight(scale),
                    ),
                    const SizedBox(height: 8),
                    _field(
                      fieldKey: const Key('jobSearchLocationField'),
                      controller: _locationController,
                      label: 'City, State',
                      hint: 'City, State — jaise Kota, Rajasthan',
                      icon: Icons.location_on_outlined,
                      action: TextInputAction.search,
                      height: _fieldHeight(scale),
                      onSubmitted: (_) => _submit(),
                    ),
                    const SizedBox(height: 12),
                    PrimaryActionButton(
                      label: 'Search',
                      showArrow: false,
                      buttonKey: const Key('jobSearchSubmitButton'),
                      // No in-button spinner — a fresh search shows the
                      // full-screen loader in the content area; the button just
                      // disables while any page fetch is in flight.
                      onPressed: state.isBusy ? null : _submit,
                    ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// One search input (spec §3.2's field): white paper, 12 corners, a 1.2
  /// hairline that rings NAVY at 1.8 on focus, and a prefix icon so a
  /// low-literacy worker can tell the "what" field from the "where" field at a
  /// glance.
  Widget _field({
    required Key fieldKey,
    required TextEditingController controller,
    required String label,
    required String hint,
    required IconData icon,
    required TextInputAction action,
    required double height,
    ValueChanged<String>? onSubmitted,
  }) {
    // A persistent accessible name — the [hint] disappears on input, so TalkBack
    // and low-literacy users would otherwise have no name for the field. The
    // prefix icon is the persistent VISUAL cue; this is the persistent AURAL one.
    return Semantics(
      label: label,
      textField: true,
      child: SizedBox(
        height: height,
        child: TextField(
          key: fieldKey,
          controller: controller,
          textInputAction: action,
          onSubmitted: onSubmitted,
          style: OnboardingTypography.inter(size: 16),
          decoration: InputDecoration(
            hintText: hint,
            hintStyle: OnboardingTypography.inter(
              size: 14,
              color: OnboardingColors.ink500,
            ),
            prefixIcon: Icon(icon, size: 20, color: OnboardingColors.ink500),
            isDense: true,
            filled: true,
            fillColor: OnboardingColors.paperWhite,
            contentPadding: const EdgeInsets.symmetric(
              horizontal: 12,
              vertical: 8,
            ),
            enabledBorder: _border(OnboardingColors.borderDefault, 1.2),
            border: _border(OnboardingColors.borderDefault, 1.2),
            focusedBorder: _border(OnboardingColors.shiftBlue, 1.8),
          ),
        ),
      ),
    );
  }

  static OutlineInputBorder _border(Color color, double width) =>
      OutlineInputBorder(
        borderRadius: BorderRadius.circular(OnboardingRadii.docked),
        borderSide: BorderSide(color: color, width: width),
      );

  Widget _content(BuildContext context, JobSearchState state) {
    switch (state.status) {
      case JobSearchStatus.idle:
        return _fillSliver(
          const BbStatusView(
            icon: Icons.search_rounded,
            title: 'Jobs dhoondein',
            subtitle: 'Job title aur city daalein — jaise CNC operator, Kota.',
          ),
        );
      case JobSearchStatus.loading:
        return const SliverFillRemaining(
          hasScrollBody: false,
          child: BbStatusView.loading(caption: 'Jobs dhoondh rahe hain…'),
        );
      case JobSearchStatus.error:
        return _fillSliver(_errorView(context, state));
      case JobSearchStatus.empty:
        return _fillSliver(_emptyView(state));
      case JobSearchStatus.results:
      case JobSearchStatus.loadingMore:
        return _resultsSliver(context, state);
    }
  }

  /// Centres a status view in the space left under the (possibly expanded)
  /// search header.
  Widget _fillSliver(Widget child) =>
      SliverFillRemaining(hasScrollBody: false, child: child);

  Widget _resultsSliver(BuildContext context, JobSearchState state) {
    final bool showTrailing = state.status == JobSearchStatus.loadingMore;
    final int count = state.items.length + (showTrailing ? 1 : 0);
    final double width = MediaQuery.sizeOf(context).width;
    return SliverPadding(
      // The card carries no side margin: this is the ONE horizontal inset, and
      // it centres the column on a tablet. The bottom clears the gesture-nav
      // inset so the last result isn't hidden.
      padding: KitInsets.list(
        width,
        gutter: 14,
      ).copyWith(
        top: 14,
        bottom:
            14 +
            MediaQuery.paddingOf(context).bottom +
            // The floating Feedback pill's band. See [FeedbackFabInset].
            FeedbackFabInset.of(context),
      ),
      sliver: SliverList(
        delegate: SliverChildBuilderDelegate((BuildContext context, int index) {
          if (index >= state.items.length) {
            // The bottom "loading more" row.
            return const Padding(
              padding: EdgeInsets.symmetric(vertical: 16),
              child: Center(child: BbSpinner(size: 28)),
            );
          }
          final JobSearchItem item = state.items[index];
          return BbJobCard(
            data: _cardData(item),
            onTitleTap: () => _openDetail(item),
          );
        }, childCount: count),
      ),
    );
  }

  Widget _errorView(BuildContext context, JobSearchState state) {
    return BbStatusView(
      icon: failureReason(state.failure).icon,
      title: 'Jobs load nahi hue.',
      subtitle: failureReason(state.failure).reason,
      action: FilledButton(
        onPressed: () => context.read<JobSearchCubit>().search(
          title: state.title,
          location: state.location,
        ),
        child: const Text('Try again'),
      ),
    );
  }

  Widget _emptyView(JobSearchState state) {
    final String forWhat = state.title.isNotEmpty
        ? state.title
        : state.location;
    return BbStatusView(
      icon: Icons.search_off_rounded,
      title: 'Koi job nahi mili.',
      subtitle:
          '"$forWhat" ke liye koi open job nahi mili. Doosra title ya city try karein.',
    );
  }
}

/// Maps a PII-free [JobSearchItem] to the shared job card. NEVER sets anything
/// employer-shaped (no company / verified / hot) — the search response carries
/// none, exactly like the feed. A null pay/shift simply hides its row; the shift
/// rides the card's right-hand meta slot (no inline apply on search — the worker
/// opens the posting to apply). The matched-skill line reuses the feed's
/// treatment (see [_searchMatchNote]).
BbJobCardData _cardData(JobSearchItem item) {
  return BbJobCardData(
    title: item.title,
    place: item.place,
    payBand: formatPayBandCompact(item.payMin, item.payMax),
    shift: shiftLabel(item.shift),
    matchNote: _searchMatchNote(item),
  );
}

/// The card's "why this job" line, from the server's closed-set
/// [JobSearchItem.matchedSkillLabel] — mirrors the feed's `matchNoteFor` wording
/// so a worker sees one consistent phrasing across surfaces. Aap-form, no
/// exclamation, PII-free (a closed-set label, never free text); null when the
/// server did not name the skill, so the card stays silent rather than guessing.
String? _searchMatchNote(JobSearchItem item) {
  final String? skill = item.matchedSkillLabel;
  if (skill == null || skill.trim().isEmpty) return null;
  return 'Aapke ${skill.trim()} ke kaam se milta-julta hai.';
}
