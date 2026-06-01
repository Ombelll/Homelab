import { PrismaClient } from "@prisma/client";
import { randomBytes, scrypt } from "node:crypto";

const prisma = new PrismaClient();

// Mirrors src/lib/password.ts (same N + maxmem) but inlined so the seed
// script doesn't need to import from src/, which would drag the @/* path
// alias through.
const N = 1 << 15;
const MAXMEM = 64 * 1024 * 1024;

function hashPasswordForSeed(plaintext: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const salt = randomBytes(16);
    scrypt(plaintext, salt, 64, { N, maxmem: MAXMEM }, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(`s1$${salt.toString("hex")}$${derivedKey.toString("hex")}`);
    });
  });
}

async function main() {
  console.log("Seeding demo data…");

  // Opt-in dev user. Off by default so production seeds don't ship with a
  // known-credential admin account. Run with:
  //   SEED_DEV_USER=1 SEED_DEV_PASSWORD=changeme npm run db:seed
  if (process.env.SEED_DEV_USER === "1") {
    const email = (process.env.SEED_DEV_EMAIL ?? "admin@local").toLowerCase();
    const password = process.env.SEED_DEV_PASSWORD ?? "homelab-dev";
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      console.log(`Dev user ${email} already exists — leaving as-is.`);
    } else {
      await prisma.user.create({
        data: {
          email,
          name: "Dev Admin",
          passwordHash: await hashPasswordForSeed(password),
          role: "admin",
        },
      });
      console.log(`Dev user created: ${email} / ${password}`);
    }
  }

  const alpha = await prisma.server.upsert({
    where: { hostname: "alpha.lan" },
    update: {},
    create: {
      name: "Alpha",
      hostname: "alpha.lan",
      ipAddress: "10.0.0.10",
      os: "Ubuntu 24.04 LTS",
      status: "online",
      lastSeenAt: new Date(),
    },
  });

  const bravo = await prisma.server.upsert({
    where: { hostname: "bravo.lan" },
    update: {},
    create: {
      name: "Bravo",
      hostname: "bravo.lan",
      ipAddress: "10.0.0.11",
      os: "Debian 12",
      status: "warning",
      lastSeenAt: new Date(Date.now() - 5 * 60 * 1000),
    },
  });

  await prisma.server.upsert({
    where: { hostname: "charlie.lan" },
    update: {},
    create: {
      name: "Charlie",
      hostname: "charlie.lan",
      ipAddress: "10.0.0.12",
      os: "Proxmox VE 8",
      status: "offline",
      lastSeenAt: new Date(Date.now() - 6 * 60 * 60 * 1000),
    },
  });

  for (const server of [alpha, bravo]) {
    for (let i = 0; i < 5; i++) {
      await prisma.metric.create({
        data: {
          serverId: server.id,
          cpuPercent: 10 + Math.random() * 60,
          memoryPercent: 30 + Math.random() * 50,
          diskPercent: 40 + Math.random() * 30,
          createdAt: new Date(Date.now() - i * 60 * 1000),
        },
      });
    }
  }

  await prisma.container.upsert({
    where: { serverId_dockerId: { serverId: alpha.id, dockerId: "demo-traefik" } },
    update: {},
    create: {
      serverId: alpha.id,
      dockerId: "demo-traefik",
      name: "traefik",
      image: "traefik:v3",
      status: "running",
      ports: JSON.stringify([
        { host: "80", container: "80", protocol: "tcp" },
        { host: "443", container: "443", protocol: "tcp" },
      ]),
    },
  });

  await prisma.container.upsert({
    where: { serverId_dockerId: { serverId: alpha.id, dockerId: "demo-grafana" } },
    update: {},
    create: {
      serverId: alpha.id,
      dockerId: "demo-grafana",
      name: "grafana",
      image: "grafana/grafana:latest",
      status: "running",
      ports: JSON.stringify([{ host: "3001", container: "3000", protocol: "tcp" }]),
    },
  });

  await prisma.container.upsert({
    where: { serverId_dockerId: { serverId: bravo.id, dockerId: "demo-postgres" } },
    update: {},
    create: {
      serverId: bravo.id,
      dockerId: "demo-postgres",
      name: "postgres",
      image: "postgres:16",
      status: "exited",
      ports: JSON.stringify([{ host: "5432", container: "5432", protocol: "tcp" }]),
    },
  });

  await prisma.alert.create({
    data: {
      serverId: bravo.id,
      type: "high-memory",
      severity: "warning",
      message: "Memory usage above 85% for 10 minutes",
    },
  });

  await prisma.alert.create({
    data: {
      serverId: null,
      type: "agent-missing",
      severity: "critical",
      message: "Charlie has not checked in for 6 hours",
    },
  });

  console.log("Seed complete.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
