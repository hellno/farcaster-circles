"use client";
import { useEffect, useState } from "react";
import type { Candidate, CandidatesResponse } from "@/lib/types";

export function useCandidates(fid: number | null) {
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (fid == null) return;
    let cancelled = false;
    (async () => {
      if (cancelled) return;
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/candidates?fid=${fid}`, {
          cache: "no-store",
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.message ?? `HTTP ${res.status}`);
        }
        const data: CandidatesResponse = await res.json();
        if (!cancelled) setCandidates(data.candidates);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fid]);

  return { candidates, loading, error };
}
