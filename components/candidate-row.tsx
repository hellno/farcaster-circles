"use client";
import { Checkbox } from "@/components/ui/checkbox";
import type { Candidate } from "@/lib/types";

interface Props {
  candidate: Candidate;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}

export function CandidateRow({ candidate, checked, disabled, onToggle }: Props) {
  return (
    <li
      className={`flex items-center gap-3 rounded-md border p-3 ${disabled ? "opacity-50" : ""}`}
    >
      <Checkbox
        checked={checked}
        disabled={disabled}
        onCheckedChange={() => onToggle()}
        aria-label={`Select @${candidate.username}`}
      />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={candidate.pfpUrl}
        alt=""
        className="h-10 w-10 rounded-full object-cover"
      />
      <div className="flex flex-1 flex-col">
        <span className="font-medium">
          {candidate.displayName || candidate.username}
        </span>
        <span className="text-xs text-muted-foreground">
          @{candidate.username} · score {candidate.score.toFixed(2)}
        </span>
      </div>
    </li>
  );
}
