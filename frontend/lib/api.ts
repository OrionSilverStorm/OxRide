const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export async function health(): Promise<{ status: string }> {
  const res = await fetch(`${API_URL}/health`);
  if (!res.ok) throw new Error(`API error ${res.status}`);
  return res.json();
}
