import '../../../core/data/candidate_search_models.dart';
import '../../../core/data/models.dart';

/// #2671 — the Find search a company job offers: its own trade's match skill,
/// the job's city (only when the filters offer it) and strict mode. The button
/// is drawn only when this returns non-null, so a draft, a closed job, a job
/// with no role, or a role outside the 16-trade catalogue offers none.
///
/// The role is the trade's BASE `match_skill_id` — deliberately not every
/// `match_skill_ids` on the posting, because those also carry the related
/// skills the payer may have unticked. The city is matched against the filters'
/// own spelling because the search 400s any city it does not recognise, and a
/// job's city is free text.
CandidateSearchQuery? matchingWorkersQuery(
  JobPosting job,
  List<PostingTradeForm> trades,
  CandidateFilters? filters,
) {
  final String wire = job.wireStatus ?? '';
  if (wire != 'open' && wire != 'paused') return null;
  final String? roleKind = job.roleKind;
  if (roleKind == null || roleKind.isEmpty) return null;
  PostingTradeForm? trade;
  for (final PostingTradeForm row in trades) {
    if (row.roleKind == roleKind) {
      trade = row;
      break;
    }
  }
  if (trade == null || trade.matchSkillId.isEmpty) return null;
  return CandidateSearchQuery(
    skillIds: <String>[trade.matchSkillId],
    city: offeredCity(filters, job.city),
    strict: true,
  );
}

/// The city as the filters spell it, or null when they do not list it (or the
/// options could not be read). Case-insensitive, trimmed.
String? offeredCity(CandidateFilters? filters, String? city) {
  if (filters == null || city == null) return null;
  final String wanted = city.trim().toLowerCase();
  if (wanted.isEmpty) return null;
  for (final String option in filters.cities) {
    if (option.trim().toLowerCase() == wanted) return option;
  }
  return null;
}
