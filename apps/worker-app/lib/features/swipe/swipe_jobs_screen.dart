import 'package:flutter/material.dart';

import '../../core/api/api_client.dart';
import '../../core/config/app_config.dart';
import '../../core/state/app_state.dart';
import '../../router.dart';

/// Alpha swipe-to-apply screen (ADR-0009 Stream C).
///
/// Shows one seeded job at a time. The worker can APPLY (swipe right / green
/// "Apply" button) or SKIP (swipe left / "Skip" button). Designed for a
/// first-time, low-literacy user: one card at a time, large tap targets, an icon
/// beside every word, minimal text.
///
/// PRIVACY: renders only the coarse, PII-free fields the API returns
/// (trade / title / city / area). There is deliberately NO employer name and NO
/// pay — the API returns none. Worker actions are scoped by the in-memory session
/// token; nothing is logged.
///
/// Sits AFTER consent in the flow. A 403 from the API (consent not accepted)
/// routes the worker back to the consent screen rather than crashing.
class SwipeJobsScreen extends StatefulWidget {
  const SwipeJobsScreen({super.key, ApiClient? api}) : _injectedApi = api;

  /// Test seam: lets a widget test inject an [ApiClient] with a fake
  /// `http.Client`. Production uses the default constructed below.
  final ApiClient? _injectedApi;

  @override
  State<SwipeJobsScreen> createState() => _SwipeJobsScreenState();
}

/// Loading / data / empty / error / consent-required states for the screen.
enum _FeedStatus { loading, ready, empty, error, consentRequired }

class _SwipeJobsScreenState extends State<SwipeJobsScreen> {
  late final ApiClient _api;

  _FeedStatus _status = _FeedStatus.loading;

  /// The remaining cards. The worker's place is the head of this list — a failed
  /// apply/skip leaves the head untouched so nothing is lost on a network drop.
  final List<FeedItem> _queue = <FeedItem>[];

  /// True while an apply/skip network call for the current card is in flight, so
  /// a double-tap can't fire two decisions or advance twice.
  bool _deciding = false;

  @override
  void initState() {
    super.initState();
    // Wire the rolling-refresh callback so a fresh `x-session-token` keeps the
    // in-memory session alive (see WorkerAuthGuard).
    _api = widget._injectedApi ??
        createApiClient(onSessionTokenRefreshed: AppState.instance.setSessionToken);
    _loadFeed();
  }

  @override
  void dispose() {
    // Only dispose a client we created; an injected one is owned by the test.
    if (widget._injectedApi == null) _api.dispose();
    super.dispose();
  }

  Future<void> _loadFeed() async {
    final String? token = AppState.instance.sessionToken;
    if (token == null || token.isEmpty) {
      // No session — should not happen after login, but fail safe rather than
      // call an authed route with no token.
      if (!mounted) return;
      setState(() => _status = _FeedStatus.error);
      return;
    }
    setState(() => _status = _FeedStatus.loading);
    try {
      final List<FeedItem> jobs = await _api.getFeed(authToken: token);
      if (!mounted) return;
      setState(() {
        _queue
          ..clear()
          ..addAll(jobs);
        _status = _queue.isEmpty ? _FeedStatus.empty : _FeedStatus.ready;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      // 403 = consent gate (ConsentGuard). Send the worker back to consent.
      setState(() => _status =
          e.statusCode == 403 ? _FeedStatus.consentRequired : _FeedStatus.error);
    } catch (_) {
      // No network / parse error — friendly retry, keep no stale state.
      if (!mounted) return;
      setState(() => _status = _FeedStatus.error);
    }
  }

  FeedItem? get _current => _queue.isEmpty ? null : _queue.first;

  /// Removes the head card and shows the empty state when the queue drains.
  void _advance() {
    if (_queue.isNotEmpty) _queue.removeAt(0);
    _status = _queue.isEmpty ? _FeedStatus.empty : _FeedStatus.ready;
  }

  Future<void> _apply() async {
    final FeedItem? job = _current;
    if (job == null || _deciding) return;
    setState(() => _deciding = true);
    final String? token = AppState.instance.sessionToken;
    if (token == null || token.isEmpty) {
      if (!mounted) return;
      setState(() {
        _deciding = false;
        _status = _FeedStatus.error;
      });
      return;
    }
    try {
      await _api.applyToJob(job.jobId, authToken: token, rank: job.rank);
      if (!mounted) return;
      setState(() {
        _advance();
        _deciding = false;
      });
    } on ApiException catch (e) {
      _handleDecisionError(e.statusCode == 403);
    } catch (_) {
      _handleDecisionError(false);
    }
  }

  Future<void> _skip() async {
    final FeedItem? job = _current;
    if (job == null || _deciding) return;
    setState(() => _deciding = true);
    final String? token = AppState.instance.sessionToken;
    if (token == null || token.isEmpty) {
      if (!mounted) return;
      setState(() {
        _deciding = false;
        _status = _FeedStatus.error;
      });
      return;
    }
    try {
      // A single-tap skip means "not interested"; the richer enum reasons are a
      // later refinement. Still a coarse, PII-free enum.
      await _api.skipJob(job.jobId, authToken: token, reason: 'not_interested');
      if (!mounted) return;
      setState(() {
        _advance();
        _deciding = false;
      });
    } on ApiException catch (e) {
      _handleDecisionError(e.statusCode == 403);
    } catch (_) {
      _handleDecisionError(false);
    }
  }

  /// Apply/skip failed. Keep the current card (the worker does not lose their
  /// place), re-enable the buttons, and surface a simple retry. A 403 means
  /// consent lapsed mid-session → route back to consent.
  void _handleDecisionError(bool consentRequired) {
    if (!mounted) return;
    if (consentRequired) {
      setState(() {
        _deciding = false;
        _status = _FeedStatus.consentRequired;
      });
      return;
    }
    setState(() => _deciding = false);
    ScaffoldMessenger.of(context)
      ..clearSnackBars()
      ..showSnackBar(
        const SnackBar(content: Text('Could not save. Please try again.')),
      );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Jobs for you')),
      body: switch (_status) {
        _FeedStatus.loading => const Center(child: CircularProgressIndicator()),
        _FeedStatus.error => _buildError(),
        _FeedStatus.consentRequired => _buildConsentRequired(),
        _FeedStatus.empty => _buildEmpty(),
        _FeedStatus.ready => _buildCard(),
      },
    );
  }

  Widget _buildCard() {
    final FeedItem job = _current!;
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          children: <Widget>[
            const SizedBox(height: 8),
            const Text(
              'Swipe right to apply, left to skip',
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 12),
            Expanded(
              child: Dismissible(
                // The job id keys the card so each swipe targets the right job.
                key: ValueKey<String>(job.jobId),
                // Block the swipe while a decision is already in flight.
                direction: _deciding
                    ? DismissDirection.none
                    : DismissDirection.horizontal,
                background: _swipeBackground(
                  alignment: Alignment.centerLeft,
                  color: Theme.of(context).colorScheme.primaryContainer,
                  icon: Icons.check_circle,
                  label: 'Apply',
                ),
                secondaryBackground: _swipeBackground(
                  alignment: Alignment.centerRight,
                  color: Theme.of(context).colorScheme.surfaceContainerHighest,
                  icon: Icons.cancel,
                  label: 'Skip',
                ),
                // Confirm performs the action; returning false keeps the card in
                // place (so a failed call does not visually drop it).
                confirmDismiss: (DismissDirection dir) async {
                  if (dir == DismissDirection.startToEnd) {
                    await _apply();
                  } else {
                    await _skip();
                  }
                  // The action itself advances the queue on success; never let
                  // Dismissible also remove the widget.
                  return false;
                },
                child: _jobCard(job),
              ),
            ),
            const SizedBox(height: 16),
            _actionButtons(),
          ],
        ),
      ),
    );
  }

  Widget _jobCard(FeedItem job) {
    final ThemeData theme = Theme.of(context);
    return Card(
      elevation: 2,
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Row(
              children: <Widget>[
                Icon(Icons.work_outline, size: 32, color: theme.colorScheme.primary),
                const SizedBox(width: 12),
                Expanded(
                  child: Text(
                    job.title,
                    style: theme.textTheme.headlineSmall,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 24),
            _infoRow(Icons.handyman, job.tradeKey),
            const SizedBox(height: 16),
            _infoRow(
              Icons.place_outlined,
              job.area == null ? job.city : '${job.area}, ${job.city}',
            ),
          ],
        ),
      ),
    );
  }

  Widget _infoRow(IconData icon, String text) {
    return Row(
      children: <Widget>[
        Icon(icon, size: 24),
        const SizedBox(width: 12),
        Expanded(
          child: Text(text, style: const TextStyle(fontSize: 18)),
        ),
      ],
    );
  }

  Widget _actionButtons() {
    return Row(
      children: <Widget>[
        Expanded(
          child: OutlinedButton.icon(
            // Keyed for tests: `*.icon` buttons are a private FilledButton/
            // OutlinedButton subclass, so find.byType(OutlinedButton) misses them.
            key: const Key('swipeSkipButton'),
            onPressed: _deciding ? null : _skip,
            style: OutlinedButton.styleFrom(
              minimumSize: const Size.fromHeight(56),
            ),
            icon: const Icon(Icons.close),
            label: const Text('Skip', style: TextStyle(fontSize: 18)),
          ),
        ),
        const SizedBox(width: 16),
        Expanded(
          child: FilledButton.icon(
            key: const Key('swipeApplyButton'),
            onPressed: _deciding ? null : _apply,
            style: FilledButton.styleFrom(
              minimumSize: const Size.fromHeight(56),
            ),
            icon: const Icon(Icons.check),
            label: const Text('Apply', style: TextStyle(fontSize: 18)),
          ),
        ),
      ],
    );
  }

  Widget _swipeBackground({
    required Alignment alignment,
    required Color color,
    required IconData icon,
    required String label,
  }) {
    return Container(
      alignment: alignment,
      padding: const EdgeInsets.symmetric(horizontal: 32),
      decoration: BoxDecoration(
        color: color,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        mainAxisAlignment: MainAxisAlignment.center,
        children: <Widget>[
          Icon(icon, size: 40),
          const SizedBox(height: 4),
          Text(label, style: const TextStyle(fontSize: 16)),
        ],
      ),
    );
  }

  /// Shown when there are no more jobs to show.
  Widget _buildEmpty() {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            const Icon(Icons.check_circle_outline, size: 48),
            const SizedBox(height: 16),
            const Text(
              'No more jobs right now.',
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 18),
            ),
            const SizedBox(height: 8),
            const Text(
              'Check back later for new jobs.',
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 24),
            FilledButton(
              onPressed: _loadFeed,
              child: const Text('Refresh'),
            ),
          ],
        ),
      ),
    );
  }

  /// Shown when the feed could not load (no network / server error). Large,
  /// simple retry — mirrors the profile screen's failed state.
  Widget _buildError() {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            const Icon(Icons.cloud_off, size: 48),
            const SizedBox(height: 16),
            const Text(
              'Could not load jobs.',
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 18),
            ),
            const SizedBox(height: 8),
            const Text(
              'Please check your internet and try again.',
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 24),
            FilledButton(
              onPressed: _loadFeed,
              child: const Text('Try again'),
            ),
          ],
        ),
      ),
    );
  }

  /// Shown when the API reports consent is required (403). Routes back to the
  /// consent screen rather than dead-ending.
  Widget _buildConsentRequired() {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            const Icon(Icons.privacy_tip_outlined, size: 48),
            const SizedBox(height: 16),
            const Text(
              'Please accept consent to see jobs.',
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 18),
            ),
            const SizedBox(height: 24),
            FilledButton(
              onPressed: () =>
                  Navigator.pushReplacementNamed(context, Routes.consent),
              child: const Text('Go to consent'),
            ),
          ],
        ),
      ),
    );
  }
}
