// Deploy: supabase functions deploy nightly-backup
// Schedule via Supabase Dashboard → Edge Functions → Cron (e.g. 0 2 * * *)
// Or call manually with service role. Writes JSON backup to Storage bucket "backups".
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

Deno.serve(async (_req) => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceKey);

  const tables = [
    "products",
    "sales",
    "sale_items",
    "expenses",
    "profiles",
    "stock_movements",
    "stock_receipts",
    "credit_payments",
    "suppliers",
    "app_settings",
  ];
  const payload: Record<string, unknown> = {
    exported_at: new Date().toISOString(),
    tables: {},
  };
  for (const t of tables) {
    const { data, error } = await admin.from(t).select("*");
    if (!error) (payload.tables as any)[t] = data;
  }

  const name = `backup-${new Date().toISOString().slice(0, 10)}.json`;
  const body = JSON.stringify(payload);
  await admin.storage.createBucket("backups", { public: false }).catch(() => null);
  const { error: upErr } = await admin.storage
    .from("backups")
    .upload(name, new Blob([body], { type: "application/json" }), { upsert: true });
  if (upErr) {
    return new Response(JSON.stringify({ error: upErr.message }), { status: 500 });
  }
  return new Response(JSON.stringify({ ok: true, file: name }), {
    headers: { "Content-Type": "application/json" },
  });
});
