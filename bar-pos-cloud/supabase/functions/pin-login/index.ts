// Deploy: supabase functions deploy pin-login --no-verify-jwt
// Allows cashiers to sign in with PIN only. Syncs Auth password + confirms email.
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

function b64(text: string) {
  return btoa(text.trim());
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(supabaseUrl, serviceKey);

    const body = await req.json();
    const pin = String(body.pin || "").trim();
    if (pin.length < 4) throw new Error("Enter a valid PIN (min 4)");

    const hashSha = await sha256Hex(pin);
    const hashB64 = b64(pin);

    const { data: matches, error: qErr } = await admin
      .from("profiles")
      .select("id, full_name, role, active, login_email, pin_hash, staff_code")
      .eq("active", true)
      .or(`pin_hash.eq.${hashSha},pin_hash.eq.${hashB64}`);

    if (qErr) throw qErr;
    const rows = (matches || []).filter(
      (p) => p.pin_hash === hashSha || p.pin_hash === hashB64,
    );
    if (rows.length === 0) throw new Error("Invalid PIN");
    if (rows.length > 1) throw new Error("PIN is not unique. Ask admin to set a unique PIN.");

    const profile = rows[0];

    // Ensure Auth password matches this PIN and email is confirmed
    const { data: userData, error: getErr } = await admin.auth.admin.getUserById(profile.id);
    if (getErr || !userData?.user) throw new Error("Auth user missing. Recreate this staff account.");

    const email =
      (profile.login_email && String(profile.login_email).trim()) ||
      userData.user.email ||
      "";
    if (!email) throw new Error("Account has no login email. Ask admin to recreate the user.");

    const { error: upErr } = await admin.auth.admin.updateUserById(profile.id, {
      password: pin,
      email_confirm: true,
    });
    if (upErr) throw upErr;

    // Keep profile in sync
    await admin
      .from("profiles")
      .update({
        pin_hash: hashSha,
        login_email: email,
        updated_at: new Date().toISOString(),
      })
      .eq("id", profile.id);

    return new Response(
      JSON.stringify({
        ok: true,
        email,
        full_name: profile.full_name,
        role: profile.role,
      }),
      { headers: { ...cors, "Content-Type": "application/json" } },
    );
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as Error).message || e) }), {
      status: 400,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
