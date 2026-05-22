"use client";
import { useState } from "react";
import type {
  Assignment,
  AssignRequest,
  AssignResponse,
  AssignErrorResponse,
  Candidate,
} from "@/lib/types";

interface UseAssignArgs {
  token: string | null;
  inviterFid: number | null;
}

export function useAssignInvites({ token, inviterFid }: UseAssignArgs) {
  const [submitting, setSubmitting] = useState(false);
  const [assignments, setAssignments] = useState<Assignment[] | null>(null);
  const [error, setError] = useState<AssignErrorResponse | null>(null);

  async function submit(selected: Candidate[]) {
    if (!token || inviterFid == null) {
      setError({ error: "unauthorized", message: "Not signed in" });
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const body: AssignRequest = {
        inviterFid,
        invitees: selected.map((c) => ({ fid: c.fid, username: c.username })),
      };
      const res = await fetch("/api/invites/assign", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data as AssignErrorResponse);
        return;
      }
      setAssignments((data as AssignResponse).assignments);
    } catch (e) {
      setError({
        error: "candidate_filter_failed",
        message: (e as Error).message,
      });
    } finally {
      setSubmitting(false);
    }
  }

  return { submit, submitting, assignments, error };
}
