export default function NotFound() {
  return (
    <main
      style={{
        display: "flex",
        minHeight: "100svh",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        textAlign: "center",
      }}
    >
      <div>
        <h1 style={{ fontSize: 28, fontWeight: 600 }}>Invite not found</h1>
        <p style={{ marginTop: 12, opacity: 0.7 }}>
          This invite may have expired or the link is wrong.
        </p>
      </div>
    </main>
  );
}
