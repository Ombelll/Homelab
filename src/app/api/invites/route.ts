import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { createInvite } from "@/lib/invites";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  emailHint: z.string().email().max(255).optional(),
});

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const invites = await prisma.invite.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      id: true,
      emailHint: true,
      expiresAt: true,
      usedAt: true,
      createdAt: true,
      createdBy: { select: { email: true } },
    },
  });
  return NextResponse.json({ invites });
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let json: unknown = {};
  try {
    json = await request.json();
  } catch {
    /* allow empty body */
  }
  const parsed = createSchema.safeParse(json ?? {});
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid payload", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const invite = await createInvite({
    createdByUserId: user.id,
    emailHint: parsed.data.emailHint,
  });

  // Plaintext token is returned exactly once. Caller should hand the
  // accept URL to the invitee out-of-band (chat, email, etc.).
  const url = new URL(request.url);
  const acceptUrl = `${url.protocol}//${url.host}/invite/${invite.token}`;
  return NextResponse.json({
    id: invite.id,
    emailHint: invite.emailHint,
    expiresAt: invite.expiresAt,
    token: invite.token,
    acceptUrl,
    notice: "Save this link now. The token will not be shown again.",
  });
}
