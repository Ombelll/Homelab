import { prisma } from "@/lib/prisma";
import { enqueueJob } from "@/lib/jobs";
import { notifyAlert } from "@/lib/notifications";

// Opt-in: only act when DASHBOARD_AUTOHEAL=1 is set on the dashboard.
const ENABLED = process.env.DASHBOARD_AUTOHEAL === "1";

// Don't restart the same container more than once per this window — give the
// restart time to take effect before trying again.
const COOLDOWN_MS = 10 * 60 * 1000;
// After this many restarts without recovering, stop and escalate instead of
// restart-looping forever.
const MAX_ATTEMPTS = 5;

/**
 * Self-heal: restart containers whose healthcheck reports "unhealthy", with a
 * per-container cooldown + attempt cap. Deliberately scoped to `unhealthy`
 * only — never `exited`/`stopped` (intentional) or `restarting` (already
 * looping). healCount resets to 0 once a container is observed healthy, so a
 * one-off blip doesn't count against a later real failure.
 *
 * Idempotent and safe to call every report: enqueueJob dedupes a pending
 * restart, and the cooldown gates repeats. No-op unless DASHBOARD_AUTOHEAL=1.
 */
export async function autoHealContainers(input: { serverId: string; serverName: string }) {
  if (!ENABLED) return;

  const containers = await prisma.container.findMany({
    where: { serverId: input.serverId },
    select: {
      id: true,
      name: true,
      dockerId: true,
      health: true,
      status: true,
      lastHealAt: true,
      healCount: true,
    },
  });

  const now = new Date();

  // Recovered containers: clear the attempt counter so a fresh failure later
  // starts from zero.
  const recovered = containers.filter(
    (c) => c.healCount > 0 && c.health !== "unhealthy" && c.status !== "restarting",
  );
  if (recovered.length) {
    await prisma.container.updateMany({
      where: { id: { in: recovered.map((c) => c.id) } },
      data: { healCount: 0 },
    });
  }

  const unhealthy = containers.filter((c) => c.health === "unhealthy");
  for (const c of unhealthy) {
    // Cooldown: a recent restart is still settling — leave it alone.
    if (c.lastHealAt && now.getTime() - c.lastHealAt.getTime() < COOLDOWN_MS) continue;

    // Gave up: too many restarts without recovery → escalate once, stop trying.
    if (c.healCount >= MAX_ATTEMPTS) {
      await reconcileGiveUp(input, c.name, true);
      continue;
    }

    await enqueueJob({
      serverId: input.serverId,
      type: "container.restart",
      payload: { dockerId: c.dockerId, containerName: c.name },
    });
    const attempt = c.healCount + 1;
    await prisma.container.update({
      where: { id: c.id },
      data: { lastHealAt: now, healCount: attempt },
    });

    const message = `Auto-restarted unhealthy container ${c.name} on ${input.serverName} (attempt ${attempt}/${MAX_ATTEMPTS})`;
    const created = await prisma.alert.create({
      data: { serverId: input.serverId, type: "container-autohealed", severity: "warning", message },
    });
    void notifyAlert({
      type: created.type,
      severity: created.severity,
      message: created.message,
      serverName: input.serverName,
      createdAt: created.createdAt,
    });
  }

  // Clear any stale give-up alerts for containers that recovered.
  for (const c of recovered) await reconcileGiveUp(input, c.name, false);
}

// One open "autoheal-exhausted" critical alert per container; resolves when the
// container recovers.
async function reconcileGiveUp(
  input: { serverId: string; serverName: string },
  containerName: string,
  exhausted: boolean,
) {
  const open = await prisma.alert.findFirst({
    where: {
      resolved: false,
      type: "autoheal-exhausted",
      serverId: input.serverId,
      message: { contains: containerName },
    },
  });
  if (exhausted) {
    if (!open) {
      const created = await prisma.alert.create({
        data: {
          serverId: input.serverId,
          type: "autoheal-exhausted",
          severity: "critical",
          message: `Gave up auto-restarting ${containerName} on ${input.serverName} after ${MAX_ATTEMPTS} attempts — still unhealthy, needs a look`,
        },
      });
      void notifyAlert({
        type: created.type,
        severity: created.severity,
        message: created.message,
        serverName: input.serverName,
        createdAt: created.createdAt,
      });
    }
  } else if (open) {
    await prisma.alert.update({ where: { id: open.id }, data: { resolved: true, resolvedAt: new Date() } });
  }
}
