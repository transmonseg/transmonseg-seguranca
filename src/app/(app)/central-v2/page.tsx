import { redirect } from "next/navigation";

export default async function CentralV2Redirect({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const cliente = typeof params.cliente === "string" ? `?cliente=${params.cliente}` : "";
  redirect(`/${cliente}`);
}
