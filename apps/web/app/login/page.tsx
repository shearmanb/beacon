import { login } from "./actions";

export default function LoginPage({ searchParams }: { searchParams: { error?: string } }) {
  return (
    <div className="card" style={{ maxWidth: 340, margin: "60px auto" }}>
      <h2 className="mono" style={{ marginTop: 0 }}>
        ◆ BEACON
      </h2>
      <form action={login} style={{ display: "flex", gap: 8 }}>
        <input className="in" style={{ flex: 1 }} type="password" name="password" placeholder="Password" autoFocus />
        <button className="btn" type="submit">
          Enter
        </button>
      </form>
      {searchParams.error && <p style={{ color: "var(--err)", marginBottom: 0 }}>Wrong password.</p>}
    </div>
  );
}
