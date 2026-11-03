import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
type User = { id: string; name: string; email: string };
type Email = {
  id: string;
  recipient: string;
  subject: string;
  body: string;
  scheduled_at: string;
  status: "scheduled" | "processing" | "sent" | "failed";
  attempts: number;
  sent_at: string | null;
  preview_url: string | null;
  last_error: string | null;
};
async function api(path: string, options: RequestInit = {}) {
  const res = await fetch(`/api${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  if (res.status === 204) return null;
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const format = (date: string | null) =>
  date
    ? new Date(date).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "medium",
      })
    : "—";
function App() {
  const [user, setUser] = useState<User | null>(null),
    [loading, setLoading] = useState(true),
    [rows, setRows] = useState<Email[]>([]),
    [tab, setTab] = useState("scheduled"),
    [compose, setCompose] = useState(false),
    [notice, setNotice] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const refresh = async () => {
    try {
      setRows(await api("/emails"));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    api("/me")
      .then(setUser)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    if (!user) return;
    void refresh();
    const id = setInterval(() => void refresh(), 2000);
    return () => clearInterval(id);
  }, [user]);
  async function login(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const data = new FormData(event.currentTarget);
    try {
      setUser(
        await api("/login", {
          method: "POST",
          body: JSON.stringify(Object.fromEntries(data)),
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function schedule(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const data = Object.fromEntries(new FormData(event.currentTarget));
    try {
      const date = new Date(String(data.scheduledAt));
      if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now())
        throw new Error("Delivery time must be in the future");
      const result = await api("/emails", {
        method: "POST",
        body: JSON.stringify({ ...data, scheduledAt: date.toISOString() }),
      });
      setCompose(false);
      setTab("scheduled");
      setNotice(
        result.queuePending
          ? "Saved to MySQL. Queue unavailable; automatic recovery is pending."
          : `Scheduled “${result.subject}”. Your email is saved.`,
      );
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const counts = {
    scheduled: rows.filter((r) =>
      ["scheduled", "processing"].includes(r.status),
    ).length,
    sent: rows.filter((r) => r.status === "sent").length,
    failed: rows.filter((r) => r.status === "failed").length,
  };
  if (loading)
    return (
      <main className="login">
        <p>Opening your outbox…</p>
      </main>
    );
  if (!user)
    return (
      <main className="login">
        <div className="login-story">
          <div className="brand">
            ↗ outbox<span>LABS</span>
          </div>
          <p className="eyebrow">MAKE ROOM FOR WHAT’S NEXT</p>
          <h1>
            The right message.
            <br />
            Right on time.
          </h1>
          <p>
            Compose now. Deliver later. A small, dependable workspace for your
            scheduled email.
          </p>
          <div className="signature">
            BUILT BY TANISH GUPTA <span> / </span> SDE INTERN ASSIGNMENT
          </div>
        </div>
        <form className="login-card" onSubmit={login}>
          <span className="eyebrow">YOUR WORKSPACE</span>
          <h2>Welcome to Outbox</h2>
          <p>Log in to schedule your next message.</p>
          <label>
            Email
            <input
              name="email"
              type="email"
              defaultValue="tanish@outbox.demo"
              required
              autoComplete="username"
            />
          </label>
          <label>
            Password
            <input
              name="password"
              type="password"
              defaultValue="OutboxDemo2026!"
              required
              autoComplete="current-password"
            />
          </label>
          <button disabled={busy}>{busy ? "Opening…" : "Log in →"}</button>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <aside>
            Public demo account is prefilled. For a separate inbox, use{" "}
            <strong>reviewer@outbox.demo</strong> with the same demo password.
            Ethereal captures test emails; it does not deliver to real inboxes.
          </aside>
        </form>
      </main>
    );
  const visible = rows.filter((r) =>
    tab === "scheduled"
      ? ["scheduled", "processing"].includes(r.status)
      : r.status === tab,
  );
  return (
    <>
      <header>
        <a className="brand" href="/">
          ↗ outbox<span>LABS</span>
        </a>
        <div className="identity">
          <span className="avatar">{user.name[0]}</span>
          <span>
            {user.name}
            <small>{user.email}</small>
          </span>
          <button
            className="quiet"
            onClick={async () => {
              await api("/logout", { method: "POST" });
              setUser(null);
              setRows([]);
              setNotice("");
              setError("");
            }}
          >
            Log out
          </button>
        </div>
      </header>
      <main className="dashboard">
        <div className="page-heading">
          <div>
            <p className="eyebrow">YOUR EMAIL WORKSPACE</p>
            <h1>A little ahead of schedule.</h1>
            <p>Good messages deserve good timing.</p>
          </div>
          <button
            onClick={() => {
              setCompose(true);
              setError("");
            }}
          >
            ＋ Compose email
          </button>
        </div>
        <div className="stats">
          {Object.entries(counts).map(([key, count]) => (
            <button
              className={`stat ${tab === key ? "selected" : ""}`}
              key={key}
              onClick={() => setTab(key)}
            >
              <span>
                {key === "scheduled" ? "◷" : key === "sent" ? "↗" : "!"}{" "}
                {key[0].toUpperCase() + key.slice(1)}
              </span>
              <strong>{count.toString().padStart(2, "0")}</strong>
            </button>
          ))}
        </div>
        {notice && (
          <div role="status" className="notice">
            {notice}
            <button
              className="quiet"
              aria-label="Dismiss notification"
              onClick={() => setNotice("")}
            >
              ×
            </button>
          </div>
        )}
        {error && !compose && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <section className="inbox">
          <div className="table-top">
            <nav aria-label="Email status">
              {Object.entries(counts).map(([key, count]) => (
                <button
                  key={key}
                  className={tab === key ? "active" : "quiet"}
                  onClick={() => setTab(key)}
                >
                  {key[0].toUpperCase() + key.slice(1)} <span>{count}</span>
                </button>
              ))}
            </nav>
            <span className="live">● Updates every 2 seconds</span>
          </div>
          <p className="timezone">
            All times shown in <strong>{zone}</strong> · Sent means accepted by
            the test SMTP server.
          </p>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Message / recipient</th>
                  <th>{tab === "sent" ? "Sent at" : "Scheduled for"}</th>
                  <th>Status</th>
                  <th>Delivery</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <strong>{row.subject}</strong>
                      <span>{row.recipient}</span>
                      <small title={row.id}>ID {row.id.slice(0, 8)}</small>
                    </td>
                    <td>
                      {format(tab === "sent" ? row.sent_at : row.scheduled_at)}
                    </td>
                    <td>
                      <span className={`badge ${row.status}`}>
                        {row.status}
                      </span>
                      <small>
                        {row.attempts} attempt{row.attempts !== 1 ? "s" : ""}
                      </small>
                    </td>
                    <td>
                      {row.preview_url ? (
                        <a
                          href={row.preview_url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Open Ethereal preview ↗
                        </a>
                      ) : (
                        row.last_error ||
                        (row.status === "sent"
                          ? "Accepted · preview unavailable"
                          : "Waiting for delivery")
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!visible.length && (
              <div className="empty">
                <div>✉</div>
                <h3>
                  {tab === "scheduled"
                    ? "Your next message starts here."
                    : tab === "sent"
                      ? "Delivered messages will appear here."
                      : "No failed deliveries."}
                </h3>
                <p>
                  {tab === "scheduled"
                    ? "Compose an email and choose a future delivery time."
                    : "We keep the delivery status visible so you know what happened."}
                </p>
              </div>
            )}
          </div>
        </section>
        <footer>
          OUTBOX LABS{" "}
          <span>Designed & built by Tanish Gupta · Test email workspace</span>
        </footer>
      </main>
      {compose && (
        <div className="overlay">
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="compose-title"
          >
            <div className="modal-head">
              <div>
                <p className="eyebrow">A MESSAGE FOR LATER</p>
                <h2 id="compose-title">Compose email</h2>
              </div>
              <button
                className="quiet"
                aria-label="Close composer"
                onClick={() => setCompose(false)}
              >
                ×
              </button>
            </div>
            <form onSubmit={schedule}>
              <label>
                Recipient
                <input
                  autoFocus
                  name="recipient"
                  type="email"
                  placeholder="alex@example.com"
                  required
                  maxLength={254}
                />
              </label>
              <label>
                Subject
                <input
                  name="subject"
                  placeholder="Something worth opening"
                  required
                  maxLength={200}
                />
              </label>
              <label>
                Message
                <textarea
                  name="body"
                  rows={5}
                  placeholder="Write your message…"
                  required
                  maxLength={10000}
                />
              </label>
              <label>
                Delivery date and time
                <input
                  name="scheduledAt"
                  type="datetime-local"
                  step="1"
                  required
                />
              </label>
              <p className="hint">
                Time zone: <strong>{zone}</strong>. Choose a future time. Your
                browser converts it to UTC for storage.
              </p>
              {error && (
                <p role="alert" className="error">
                  {error}
                </p>
              )}
              <div className="modal-actions">
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setCompose(false)}
                >
                  Cancel
                </button>
                <button disabled={busy}>
                  {busy ? "Saving…" : "Schedule email →"}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
