import Link from "next/link";
import { requireCapability } from "../../../lib/auth";
import { isAdminRequestError } from "../../../lib/admin-http";
import { listMovedStudents, type MovedStudent } from "../../../lib/students";
import { PageHeader } from "../../../components/page-header";
import { StatusPill } from "../../../components/status-pill";
import {
  BulkVisibilityControl,
  StudentVisibilitySwitch,
} from "../../../components/student-visibility-controls";
import { formatTimestamp, shortId } from "../../../lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Moved students" };

function one(value: string | string[] | undefined): string | undefined {
  return (Array.isArray(value) ? value[0] : value)?.trim() || undefined;
}

/**
 * #2887 — RVM students moved into BadaBhai, hidden until an admin shows them.
 *
 * Gated on `manage_student_visibility` (super_admin, ops_admin). A 404 means the move switch is
 * off; a 503 means the table is missing. Hidden students are not matched to jobs and not shown to
 * companies.
 */
export default async function MovedStudentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireCapability("manage_student_visibility");
  const sp = await searchParams;
  const batchId = one(sp.batch_id);
  const visibleRaw = one(sp.visible);
  const visible = visibleRaw === "true" ? true : visibleRaw === "false" ? false : undefined;
  const branch = one(sp.branch);
  const course = one(sp.course);
  const cursor = one(sp.cursor);

  let page: Awaited<ReturnType<typeof listMovedStudents>> | null = null;
  let off = false;
  let missing = false;
  try {
    page = await listMovedStudents({
      ...(batchId ? { batchId } : {}),
      ...(visible !== undefined ? { visible } : {}),
      ...(branch ? { branch } : {}),
      ...(course ? { course } : {}),
      ...(cursor ? { cursor } : {}),
      limit: 50,
    });
  } catch (err) {
    if (isAdminRequestError(err) && err.status === 404) off = true;
    else if (isAdminRequestError(err) && err.status === 503) missing = true;
    else throw err;
  }

  if (off || missing) {
    return (
      <div className="page page--reading">
        <PageHeader
          title="Moved students"
          description="RVM students moved into BadaBhai, hidden until an admin shows them."
        />
        <section className="panel">
          <div className={off ? "state" : "state state--error"}>
            <h2 className="state__title">
              {off ? "The student move is not switched on yet" : "The students table is not ready"}
            </h2>
            <p className="state__body">
              {off
                ? "Until STUDENT_MOVE_ENABLED is on, no student has been moved."
                : "Retry after the migration lands."}
            </p>
          </div>
        </section>
      </div>
    );
  }

  const students = page?.students ?? [];
  const batches = [...new Set(students.map((s) => s.batch_id).filter((v): v is string => Boolean(v)))];
  const branches = [...new Set(students.map((s) => s.branch).filter((v): v is string => Boolean(v)))];
  const courses = [...new Set(students.map((s) => s.course).filter((v): v is string => Boolean(v)))];

  return (
    <div className="page page--reading">
      <PageHeader
        title="Moved students"
        description="RVM students moved into BadaBhai, hidden until an admin shows them."
      />

      <section className="panel">
        <div className="alert alert--info">
          <p className="alert__body">
            While hidden: not matched to jobs and not shown to companies.
          </p>
        </div>

        <form className="form" method="get">
          <label className="field" htmlFor="filter-batch">
            <span className="field__label">Import run</span>
            <input
              id="filter-batch"
              name="batch_id"
              className="field__input"
              defaultValue={batchId ?? ""}
            />
          </label>
          <label className="field" htmlFor="filter-visible">
            <span className="field__label">Visible</span>
            <select
              id="filter-visible"
              name="visible"
              className="field__input"
              defaultValue={visibleRaw ?? ""}
            >
              <option value="">Any</option>
              <option value="true">Yes</option>
              <option value="false">No</option>
            </select>
          </label>
          <label className="field" htmlFor="filter-branch">
            <span className="field__label">Branch</span>
            <input
              id="filter-branch"
              name="branch"
              className="field__input"
              defaultValue={branch ?? ""}
            />
          </label>
          <label className="field" htmlFor="filter-course">
            <span className="field__label">Course</span>
            <input
              id="filter-course"
              name="course"
              className="field__input"
              defaultValue={course ?? ""}
            />
          </label>
          <button className="btn btn--primary btn--sm" type="submit">
            Filter
          </button>
        </form>

        {students.length === 0 ? (
          <div className="state">
            <h2 className="state__title">No moved students here</h2>
            <p className="state__body">No student matches these filters.</p>
          </div>
        ) : (
          <div className="tablewrap">
            <table className="table">
              <caption className="sr-only">Moved students</caption>
              <thead>
                <tr>
                  <th scope="col">Worker</th>
                  <th scope="col">Visible</th>
                  <th scope="col">Import run</th>
                  <th scope="col">Branch</th>
                  <th scope="col">Course</th>
                  <th scope="col">Changed</th>
                  <th scope="col">Action</th>
                </tr>
              </thead>
              <tbody>
                {students.map((s: MovedStudent) => (
                  <tr key={s.worker_id}>
                    <td>
                      <Link href={`/candidates/${s.worker_id}`}>{shortId(s.worker_id)}</Link>
                    </td>
                    <td>
                      <StatusPill
                        value={s.visible ? "on" : "off"}
                        label={s.visible ? "Visible" : "Hidden"}
                        tone={s.visible ? "ok" : "warn"}
                      />
                    </td>
                    <td>{s.batch_id ? shortId(s.batch_id) : "—"}</td>
                    <td>{s.branch ?? "—"}</td>
                    <td>{s.course ?? "—"}</td>
                    <td>{formatTimestamp(s.changed_at)}</td>
                    <td>
                      <StudentVisibilitySwitch workerId={s.worker_id} visible={s.visible} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {page?.next_cursor ? (
          <div className="state__actions">
            <Link
              className="btn btn--ghost"
              href={`/students?${new URLSearchParams({
                ...(batchId ? { batch_id: batchId } : {}),
                ...(visibleRaw ? { visible: visibleRaw } : {}),
                ...(branch ? { branch } : {}),
                ...(course ? { course } : {}),
                cursor: page.next_cursor,
              }).toString()}`}
            >
              Next page
            </Link>
          </div>
        ) : null}

        <BulkVisibilityControl batches={batches} branches={branches} courses={courses} />
      </section>
    </div>
  );
}
