import { notFound, redirect } from "next/navigation";

export default async function ServicePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ sessionId?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  if (!query.sessionId) notFound();
  redirect(
    `/work/${encodeURIComponent(id)}?sessionId=${encodeURIComponent(query.sessionId)}`,
  );
}
