import dgram from "node:dgram";

/**
 * Send a Wake-on-LAN magic packet for the given MAC address.
 *
 * Packet format: 6 bytes of 0xFF followed by 16 repetitions of the target's
 * 6-byte MAC. We broadcast to UDP 255.255.255.255 on port 9 (the "discard"
 * port, the de-facto standard for WoL). Will only reach the target if the
 * dashboard host is on the same broadcast domain (i.e. same LAN). For a
 * remote WoL, set up a per-host relay (out of scope for MVP).
 */
export async function sendMagicPacket(mac: string): Promise<void> {
  const bytes = parseMac(mac);
  if (!bytes) throw new Error("invalid MAC address");

  const packet = Buffer.alloc(6 + 16 * 6);
  packet.fill(0xff, 0, 6);
  for (let i = 0; i < 16; i++) {
    bytes.copy(packet, 6 + i * 6);
  }

  await new Promise<void>((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    socket.once("error", (err) => {
      socket.close();
      reject(err);
    });
    socket.bind(() => {
      socket.setBroadcast(true);
      socket.send(packet, 0, packet.length, 9, "255.255.255.255", (err) => {
        socket.close();
        if (err) reject(err);
        else resolve();
      });
    });
  });
}

/**
 * Accept MAC formats like "aa:bb:cc:dd:ee:ff", "AA-BB-CC-DD-EE-FF", or
 * "aabbccddeeff". Returns a 6-byte Buffer, or null on garbage.
 */
export function parseMac(raw: string): Buffer | null {
  const stripped = raw.trim().replace(/[:.\-\s]/g, "");
  if (!/^[0-9a-fA-F]{12}$/.test(stripped)) return null;
  return Buffer.from(stripped, "hex");
}
