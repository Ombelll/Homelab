import { prisma } from "@/lib/prisma";

/**
 * Container image update checker.
 *
 * Scope: only **Docker Hub** images are checked. We resolve the registry
 * manifest digest via the public auth-token + HEAD-manifest flow and
 * compare against the local digest the agent reported. Other registries
 * (ghcr.io, lscr.io, quay.io, private) are skipped with a logged note.
 *
 * Why only Docker Hub: every registry has slightly different auth, scope,
 * and manifest formats. Supporting the long tail well is a project on its
 * own. The 80% homelab case is Docker Hub, so we cover that.
 */

const CHECK_AFTER_MS = 6 * 60 * 60 * 1000; // 6 hours

export async function checkContainerImageUpdates(): Promise<{
  checked: number;
  updated: number;
  skipped: number;
}> {
  const containers = await prisma.container.findMany({
    where: {
      imageDigest: { not: null },
      OR: [
        { lastUpdateCheck: null },
        { lastUpdateCheck: { lt: new Date(Date.now() - CHECK_AFTER_MS) } },
      ],
    },
  });

  // Dedupe by image so we don't poll Docker Hub once per container.
  const byImage = new Map<string, typeof containers>();
  for (const c of containers) {
    const list = byImage.get(c.image);
    if (list) list.push(c);
    else byImage.set(c.image, [c]);
  }

  let checked = 0;
  let updated = 0;
  let skipped = 0;

  for (const [image, group] of byImage) {
    const ref = parseImageRef(image);
    if (!ref || ref.registry !== "docker.io") {
      // Not Docker Hub — flag the row(s) as checked so we don't retry on
      // every cron tick, but record a "skipped" note.
      await prisma.container.updateMany({
        where: { id: { in: group.map((g) => g.id) } },
        data: { lastUpdateCheck: new Date() },
      });
      skipped += group.length;
      continue;
    }

    checked += group.length;
    try {
      const remoteDigest = await fetchDockerHubManifestDigest(ref.repository, ref.tag);
      const at = new Date();
      for (const c of group) {
        const isUpdate = Boolean(remoteDigest) && !!c.imageDigest && remoteDigest !== c.imageDigest;
        await prisma.container.update({
          where: { id: c.id },
          data: {
            remoteDigest: remoteDigest ?? null,
            updateAvailable: isUpdate,
            lastUpdateCheck: at,
          },
        });
        if (isUpdate) updated++;
      }
    } catch (err) {
      console.warn(`[image-updates] ${image}: ${(err as Error).message}`);
      await prisma.container.updateMany({
        where: { id: { in: group.map((g) => g.id) } },
        data: { lastUpdateCheck: new Date() },
      });
    }
  }

  return { checked, updated, skipped };
}

type ImageRef = { registry: string; repository: string; tag: string };

/**
 * Parses image references like:
 *   nginx                 → docker.io/library/nginx:latest
 *   grafana/grafana       → docker.io/grafana/grafana:latest
 *   grafana/grafana:9.5   → docker.io/grafana/grafana:9.5
 *   ghcr.io/foo/bar:dev   → ghcr.io/foo/bar:dev
 *
 * Returns null on something unparseable.
 */
export function parseImageRef(image: string): ImageRef | null {
  if (!image) return null;

  // Split off tag (anything after the last colon, unless it's a port — but
  // ports only appear in registries, and we handle that below).
  let registry = "docker.io";
  let body = image;
  const firstSlash = image.indexOf("/");
  const firstSegment = firstSlash === -1 ? image : image.slice(0, firstSlash);
  if (firstSlash !== -1 && (firstSegment.includes(".") || firstSegment.includes(":"))) {
    registry = firstSegment;
    body = image.slice(firstSlash + 1);
  }

  let tag = "latest";
  const colon = body.lastIndexOf(":");
  if (colon !== -1 && !body.slice(colon + 1).includes("/")) {
    tag = body.slice(colon + 1);
    body = body.slice(0, colon);
  }

  // Docker Hub convention: a single-segment name → library/<name>.
  let repository = body;
  if (registry === "docker.io" && !repository.includes("/")) {
    repository = `library/${repository}`;
  }

  return { registry, repository, tag };
}

/**
 * Get the manifest digest of a Docker Hub image. Uses the anonymous-pull
 * token flow and the HEAD /v2/<name>/manifests/<tag> endpoint, asking for
 * both v2 and OCI manifest media types.
 */
async function fetchDockerHubManifestDigest(repository: string, tag: string): Promise<string | null> {
  // 1. Acquire an anonymous pull token for this repository.
  const tokenRes = await fetch(
    `https://auth.docker.io/token?service=registry.docker.io&scope=${encodeURIComponent(
      `repository:${repository}:pull`,
    )}`,
  );
  if (!tokenRes.ok) throw new Error(`token ${tokenRes.status}`);
  const { token } = (await tokenRes.json()) as { token?: string };
  if (!token) throw new Error("no token in response");

  // 2. HEAD the manifest. Accept both legacy v2 and OCI media types so
  // images published as either format return a digest.
  const accept = [
    "application/vnd.docker.distribution.manifest.v2+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.oci.image.index.v1+json",
  ].join(", ");

  const res = await fetch(
    `https://registry-1.docker.io/v2/${repository}/manifests/${encodeURIComponent(tag)}`,
    {
      method: "HEAD",
      headers: { Authorization: `Bearer ${token}`, Accept: accept },
    },
  );
  if (!res.ok) {
    // 404 = tag doesn't exist (typo, deleted). Treat as null so we don't
    // raise the alarm.
    if (res.status === 404) return null;
    throw new Error(`manifest HEAD ${res.status}`);
  }
  return res.headers.get("docker-content-digest");
}
