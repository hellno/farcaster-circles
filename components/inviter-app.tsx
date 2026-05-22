"use client";
import { useMemo, useState } from "react";
import { useMiniappSdk } from "@/hooks/use-miniapp-sdk";
import { useCandidates } from "@/hooks/use-candidates";
import { useAssignInvites } from "@/hooks/use-assign-invites";
import { CandidateList } from "@/components/candidate-list";
import { InviteResultList } from "@/components/invite-result-list";
import { EmptyState } from "@/components/empty-state";
import { FooterDisclaimer } from "@/components/footer-disclaimer";
import { Button } from "@/components/ui/button";
import { MAX_INVITES_PER_BATCH } from "@/lib/constants";
import type { Candidate } from "@/lib/types";

export function InviterApp() {
  const sdk = useMiniappSdk();
  const { candidates, loading, error } = useCandidates(sdk.fid);
  const [selected, setSelected] = useState<Record<number, Candidate>>({});
  const {
    submit,
    submitting,
    assignments,
    error: assignError,
  } = useAssignInvites({
    token: sdk.token,
    inviterFid: sdk.fid,
  });

  const selectedList = useMemo(() => Object.values(selected), [selected]);
  const atCap = selectedList.length >= MAX_INVITES_PER_BATCH;

  function toggle(c: Candidate) {
    setSelected((prev) => {
      const next = { ...prev };
      if (next[c.fid]) delete next[c.fid];
      else if (!atCap) next[c.fid] = c;
      return next;
    });
  }

  // Once results are in, show them prominently
  if (assignments && assignments.length > 0) {
    return (
      <main className="mx-auto flex min-h-svh max-w-md flex-col gap-6 p-6">
        <header>
          <h1 className="text-xl font-semibold">Invites ready</h1>
          <p className="text-sm text-muted-foreground">
            Tap each to open Warpcast DM compose.
          </p>
        </header>
        <InviteResultList assignments={assignments} />
        <FooterDisclaimer />
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-svh max-w-md flex-col gap-6 p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">
          Invite a Farcaster friend to Circles
        </h1>
        <p className="text-sm text-muted-foreground">
          Pick up to {MAX_INVITES_PER_BATCH} mutual follows with strong Neynar
          score. Each gets a 1-to-1 invite via DM.
        </p>
      </header>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
          {error}
        </div>
      )}

      {!sdk.inHost && !loading && (
        <div className="rounded-md border bg-muted p-3 text-sm">
          This mini app works inside Warpcast. Open it from a Farcaster client
          to sign in.
        </div>
      )}

      <CandidateList
        candidates={candidates}
        loading={loading}
        selected={selected}
        onToggle={toggle}
        atCap={atCap}
      />

      {candidates !== null && candidates.length === 0 && <EmptyState />}

      <div className="sticky bottom-4 flex items-center justify-between gap-3 rounded-md border bg-background/95 p-3 backdrop-blur">
        <div className="text-sm text-muted-foreground">
          {selectedList.length}/{MAX_INVITES_PER_BATCH} selected
        </div>
        <Button
          disabled={selectedList.length === 0 || submitting || !sdk.token}
          onClick={() => submit(selectedList)}
        >
          {submitting
            ? "Sending…"
            : `Invite ${selectedList.length || ""}`.trim()}
        </Button>
      </div>

      {assignError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
          {assignError.message}
        </div>
      )}

      <FooterDisclaimer />
    </main>
  );
}
