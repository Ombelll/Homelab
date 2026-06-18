import { describe, it, expect } from "vitest";
import { partitionResources } from "@/lib/proxmox";

const MiB = 1048576;

// A representative /cluster/resources payload (the fields we read).
const sample = [
  {
    type: "node",
    node: "Proxmox-01",
    status: "online",
    cpu: 0.087,
    maxcpu: 6,
    mem: 10 * 1024 * MiB,
    maxmem: 16 * 1024 * MiB,
    uptime: 200000,
    level: "",
  },
  {
    type: "node",
    node: "Proxmox-02",
    status: "offline",
    cpu: 0,
    maxcpu: 6,
    mem: 0,
    maxmem: 16 * 1024 * MiB,
    uptime: 0,
  },
  {
    type: "lxc",
    vmid: 101,
    name: "docker",
    node: "Proxmox-01",
    status: "running",
    cpu: 0.12,
    maxcpu: 4,
    mem: 2048 * MiB,
    maxmem: 4096 * MiB,
    disk: 30000 * MiB,
    maxdisk: 50000 * MiB,
    uptime: 86400,
    template: 0,
    tags: "prod;web",
  },
  {
    type: "qemu",
    vmid: 200,
    name: "winvm",
    node: "Proxmox-02",
    status: "stopped",
    maxcpu: 2,
    maxmem: 8192 * MiB,
    template: 1,
  },
  // Non-guest resource types must be ignored.
  { type: "storage", storage: "tank", node: "Proxmox-01" },
  { type: "sdn", sdn: "localnetwork" },
];

describe("partitionResources", () => {
  it("splits nodes and guests and converts bytes to MiB", () => {
    const { nodes, guests } = partitionResources(sample);
    expect(nodes.map((n) => n.node)).toEqual(["Proxmox-01", "Proxmox-02"]);
    expect(guests.map((g) => g.vmid)).toEqual([101, 200]);

    const n1 = nodes[0];
    expect(n1.status).toBe("online");
    expect(n1.memUsedMb).toBe(10240);
    expect(n1.memTotalMb).toBe(16384);
    expect(n1.maxCpu).toBe(6);
  });

  it("maps an lxc guest with disk + tags", () => {
    const { guests } = partitionResources(sample);
    const docker = guests.find((g) => g.vmid === 101)!;
    expect(docker.type).toBe("lxc");
    expect(docker.name).toBe("docker");
    expect(docker.node).toBe("Proxmox-01");
    expect(docker.status).toBe("running");
    expect(docker.memUsedMb).toBe(2048);
    expect(docker.maxMemMb).toBe(4096);
    expect(docker.diskUsedMb).toBe(30000);
    expect(docker.maxDiskMb).toBe(50000);
    expect(docker.template).toBe(false);
    expect(docker.tags).toBe("prod;web");
  });

  it("handles a stopped template VM with missing metric fields", () => {
    const { guests } = partitionResources(sample);
    const win = guests.find((g) => g.vmid === 200)!;
    expect(win.type).toBe("qemu");
    expect(win.status).toBe("stopped");
    expect(win.template).toBe(true);
    expect(win.cpu).toBeNull();
    expect(win.memUsedMb).toBeNull();
    expect(win.maxMemMb).toBe(8192);
    expect(win.tags).toBeNull();
  });

  it("ignores non-node/guest resource types", () => {
    const { nodes, guests } = partitionResources(sample);
    expect(nodes).toHaveLength(2);
    expect(guests).toHaveLength(2);
  });

  it("drops guests without a usable vmid", () => {
    const { guests } = partitionResources([
      { type: "lxc", name: "broken", node: "n", status: "running" },
      { type: "qemu", vmid: 5, name: "ok", node: "n", status: "running" },
    ]);
    expect(guests.map((g) => g.vmid)).toEqual([5]);
  });

  it("throws on a non-array payload", () => {
    expect(() => partitionResources(null)).toThrow();
    expect(() => partitionResources({})).toThrow();
  });
});
