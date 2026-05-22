"use client";
import { CandidateRow } from "@/components/candidate-row";
import { Skeleton } from "@/components/ui/skeleton";
import type { Candidate } from "@/lib/types";

interface Props {
  candidates: Candidate[] | null;
  loading: boolean;
  selected: Record<number, Candidate>;
  onToggle: (c: Candidate) => void;
  atCap: boolean;
}

export function CandidateList({
  candidates,
  loading,
  selected,
  onToggle,
  atCap,
}: Props) {
  if (loading && candidates === null) {
    return (
      <ul className="flex flex-col gap-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <li
            key={i}
            className="flex items-center gap-3 rounded-md border p-3"
          >
            <Skeleton className="h-10 w-10 rounded-full" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-20" />
            </div>
          </li>
        ))}
      </ul>
    );
  }
  if (!candidates || candidates.length === 0) return null;

  return (
    <ul className="flex flex-col gap-2">
      {candidates.map((c) => (
        <CandidateRow
          key={c.fid}
          candidate={c}
          checked={!!selected[c.fid]}
          disabled={atCap && !selected[c.fid]}
          onToggle={() => onToggle(c)}
        />
      ))}
    </ul>
  );
}
