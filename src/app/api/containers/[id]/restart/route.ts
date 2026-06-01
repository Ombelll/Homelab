import { dispatchContainerAction } from "@/lib/container-actions";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  return dispatchContainerAction(params.id, "restart");
}
