import { ImageResponse } from "next/og";
import { getAssignment } from "@/lib/kv";
import { fetchUserByFid } from "@/lib/neynar";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const runtime = "nodejs";

interface Props {
  params: Promise<{ shortcode: string }>;
}

export default async function OgImage({ params }: Props) {
  const { shortcode } = await params;
  const record = await getAssignment(shortcode);

  const inviter = record
    ? await fetchUserByFid(record.inviterFid).catch(() => null)
    : null;
  const inviterName =
    inviter?.displayName ?? inviter?.username ?? "Someone";
  const inviterPfp = inviter?.pfpUrl ?? null;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 40,
          background:
            "linear-gradient(135deg, #1a1530 0%, #3a2a5e 50%, #6b4eaa 100%)",
          color: "#f4ecff",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        {inviterPfp ? (
          <img
            src={inviterPfp}
            alt=""
            width={200}
            height={200}
            style={{
              borderRadius: "100%",
              border: "6px solid #d6c4ff",
            }}
          />
        ) : (
          <div
            style={{
              width: 200,
              height: 200,
              borderRadius: "100%",
              background: "#d6c4ff",
            }}
          />
        )}
        <div style={{ fontSize: 56, fontWeight: 700 }}>{inviterName}</div>
        <div style={{ fontSize: 40, opacity: 0.85 }}>
          invited you to Circles
        </div>
        <div style={{ fontSize: 24, opacity: 0.6, marginTop: 20 }}>
          a community network where people vouch for each other
        </div>
      </div>
    ),
    { ...size }
  );
}
