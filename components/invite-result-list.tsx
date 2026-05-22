"use client";
import { Button } from "@/components/ui/button";
import type { Assignment } from "@/lib/types";

async function openDm(deepLink: string) {
  try {
    const { sdk } = await import("@farcaster/miniapp-sdk");
    await sdk.actions.openUrl(deepLink);
  } catch {
    window.open(deepLink, "_blank");
  }
}

interface Props {
  assignments: Assignment[];
}

export function InviteResultList({ assignments }: Props) {
  return (
    <ul className="flex flex-col gap-2">
      {assignments.map((a) => (
        <li
          key={a.shortcode}
          className="flex items-center justify-between rounded-md border p-3"
        >
          <div className="flex flex-col">
            <span className="font-medium">@{a.inviteeUsername}</span>
            <span className="text-xs text-muted-foreground break-all">
              {a.shortUrl}
            </span>
          </div>
          <Button size="sm" onClick={() => openDm(a.dmDeepLink)}>
            Open DM
          </Button>
        </li>
      ))}
    </ul>
  );
}
