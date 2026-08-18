import { requireCapability } from "../../../../../lib/auth";
import { EntityTimeline } from "../../../../../components/entity-timeline";

export const dynamic = "force-dynamic";
export const metadata = { title: "Job posting timeline" };

export default async function JobTimelinePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireCapability("read_events");
  const { id } = await params;
  const sp = await searchParams;
  const cursor = (Array.isArray(sp.cursor) ? sp.cursor[0] : sp.cursor)?.trim() || undefined;

  return (
    <EntityTimeline
      type="job_posting"
      id={id}
      cursor={cursor}
      basePath={`/jobs/${id}/timeline`}
      backHref={`/jobs/${id}`}
      backLabel="Job posting"
    />
  );
}
