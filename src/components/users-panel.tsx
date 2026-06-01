"use client";

import { useEffect, useState } from "react";
import { Loader2, Trash2, Users } from "lucide-react";
import { formatRelativeTime } from "@/lib/utils";

type User = {
  id: string;
  email: string;
  name: string | null;
  role: "admin" | "viewer";
  createdAt: string;
  activeSessions: number;
};

export function UsersPanel() {
  const [users, setUsers] = useState<User[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load() {
    try {
      const res = await fetch("/api/users", { cache: "no-store" });
      const data = await res.json();
      setUsers(data.users ?? []);
      setError(null);
    } catch {
      setError("failed to load users");
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function setRole(id: string, role: "admin" | "viewer") {
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch(`/api/users/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `update failed (${res.status})`);
      }
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  async function remove(id: string, label: string) {
    if (!confirm(`Delete user ${label}? They will be signed out immediately and any data they created remains.`)) {
      return;
    }
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch(`/api/users/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `delete failed (${res.status})`);
      }
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="mb-4 flex items-center gap-2">
        <Users className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">Users</h2>
      </div>

      <p className="mb-4 text-xs text-muted-foreground">
        Promote viewers to admins or remove inactive accounts. The system
        won&rsquo;t let you demote or delete the last admin.
      </p>

      {error ? <div className="mb-3 text-sm text-destructive">{error}</div> : null}

      {users === null ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : users.length === 0 ? (
        <div className="text-sm text-muted-foreground">No users yet.</div>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="py-2 text-left font-medium">User</th>
              <th className="py-2 text-left font-medium">Role</th>
              <th className="py-2 text-left font-medium">Sessions</th>
              <th className="py-2 text-left font-medium">Joined</th>
              <th className="py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {users.map((u) => (
              <tr key={u.id}>
                <td className="py-2">
                  <div className="font-medium">{u.name || u.email}</div>
                  {u.name ? (
                    <div className="text-xs text-muted-foreground">{u.email}</div>
                  ) : null}
                </td>
                <td className="py-2">
                  <select
                    value={u.role}
                    disabled={busyId === u.id}
                    onChange={(e) => setRole(u.id, e.target.value as "admin" | "viewer")}
                    className="rounded-md border border-border bg-background px-2 py-1 text-xs outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
                  >
                    <option value="admin">admin</option>
                    <option value="viewer">viewer</option>
                  </select>
                </td>
                <td className="py-2 text-muted-foreground">{u.activeSessions}</td>
                <td className="py-2 text-muted-foreground">
                  {formatRelativeTime(u.createdAt)}
                </td>
                <td className="py-2 text-right">
                  <button
                    type="button"
                    disabled={busyId === u.id}
                    onClick={() => remove(u.id, u.email)}
                    className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-50"
                  >
                    {busyId === u.id ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Trash2 className="h-3 w-3" />
                    )}
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
