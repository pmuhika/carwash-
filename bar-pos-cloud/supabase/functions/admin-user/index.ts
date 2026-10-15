// Deploy: supabase functions deploy admin-user --no-verify-jwt
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Actions: create | reset_pin | delete (soft)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function sha256Hex(text: string) {
  const data = new TextEncoder().encode(text.trim());
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("Missing Authorization");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || serviceKey;

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const admin = createClient(supabaseUrl, serviceKey);

    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData.user) throw new Error("Not signed in");

    const { data: prof } = await admin
      .from("profiles")
      .select("role,active")
      .eq("id", userData.user.id)
      .maybeSingle();
    if (!prof || !prof.active || prof.role !== "admin") {
      throw new Error("Admin only");
    }

    const body = await req.json();
    const action = body.action as string;

    if (action === "create") {
      const full_name = String(body.full_name || "").trim();
      const pin = String(body.pin || "").trim();
      const role = body.role === "admin" ? "admin" : "cashier";
      const staff_code = String(body.staff_code || full_name)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "")
        .slice(0, 20);
      if (!full_name || pin.length < 4 || !staff_code) {
        throw new Error("Name, staff code, and PIN (min 4) required");
      }
      const loginEmail = `${staff_code}@bar.local`;
      const { data: created, error: cErr } = await admin.auth.admin.createUser({
        email: loginEmail,
        password: pin,
        email_confirm: true,
        user_metadata: { full_name },
      });
      if (cErr) throw cErr;
      const pin_hash = await sha256Hex(pin);
      const allowed =
        role === "admin"
          ? [
              "Dashboard",
              "Sell",
              "Receive Stock",
              "Inventory",
              "Products",
              "Credits",
              "Suppliers",
              "Expenses",
              "Reports",
              "Users",
              "Activity Log",
              "Backup & Settings",
            ]
          : body.allowed_tabs?.length
            ? body.allowed_tabs
            : ["Dashboard", "Sell", "Credits", "Expenses"];
      await admin.from("profiles").upsert({
        id: created.user!.id,
        full_name,
        role,
        active: true,
        staff_code,
        login_email: loginEmail,
        pin_hash,
        allowed_tabs: allowed,
      });
      return new Response(
        JSON.stringify({ ok: true, user_id: created.user!.id, login_email: loginEmail }),
        { headers: { ...cors, "Content-Type": "application/json" } },
      );
    }

    if (action === "reset_pin") {
      const user_id = body.user_id as string;
      const pin = String(body.pin || "").trim();
      if (!user_id || pin.length < 4) throw new Error("user_id and PIN required");
      const pin_hash = await sha256Hex(pin);
      const { error: uErr } = await admin.auth.admin.updateUserById(user_id, {
        password: pin,
      });
      if (uErr) throw uErr;
      await admin.from("profiles").update({ pin_hash, updated_at: new Date().toISOString() }).eq("id", user_id);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    if (action === "delete") {
      const user_id = body.user_id as string;
      if (!user_id) throw new Error("user_id required");
      if (user_id === userData.user.id) throw new Error("Cannot delete yourself");
      await admin
        .from("profiles")
        .update({ active: false, pin_hash: null, updated_at: new Date().toISOString() })
        .eq("id", user_id);
      try {
        await admin.auth.admin.updateUserById(user_id, { ban_duration: "876000h" });
      } catch {
        /* optional */
      }
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    throw new Error("Unknown action");
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as Error).message || e) }), {
      status: 400,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
