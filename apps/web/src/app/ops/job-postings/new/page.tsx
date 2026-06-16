import Link from "next/link";
import { PostingCreateForm } from "./posting-create-form";

/** Create a new job posting (ADR-0010). Always created as `draft`. */
export default function NewJobPostingPage() {
  return (
    <>
      <p className="page-sub">
        <Link href="/ops/job-postings">← Job Postings</Link>
      </p>
      <h1 className="page-title">New job posting</h1>
      <p className="page-sub">
        Created as a draft. Publish it from the posting page once it&apos;s ready.
      </p>

      <PostingCreateForm />
    </>
  );
}
