"use client";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-xl font-semibold">Something went wrong.</h1>
      <p className="text-sm text-muted-foreground">{error.message || "Unexpected error."}</p>
      <Button onClick={() => reset()}>Try again</Button>
    </main>
  );
}
