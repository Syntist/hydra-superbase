import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

Deno.serve(async (request) => {
  if (request.method !== "POST")
    return json({ error: "Method not allowed" }, 405);

  const authorization = request.headers.get("Authorization") ?? "";
  const hydraToken = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";
  if (!hydraToken) return json({ error: "Hydra token required" }, 401);

  const hydraApiUrl = Deno.env.get("HYDRA_API_URL")?.replace(/\/$/, "");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!hydraApiUrl || !supabaseUrl || !serviceRoleKey || !anonKey) {
    return json({ error: "Auth bridge is not configured" }, 500);
  }

  const hydraResponse = await fetch(`${hydraApiUrl}/profile/me`, {
    headers: { Authorization: `Bearer ${hydraToken}` },
  });
  if (!hydraResponse.ok) return json({ error: "Invalid Hydra session" }, 401);

  const hydraUser = (await hydraResponse.json()) as {
    id?: string;
    email?: string | null;
  };
  if (!hydraUser.id) return json({ error: "Hydra user ID missing" }, 502);

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: initialLink, error: linkError } = await admin
    .from("hydra_user_links")
    .select("supabase_user_id,supabase_email")
    .eq("hydra_user_id", hydraUser.id)
    .maybeSingle();
  if (linkError) return json({ error: linkError.message }, 500);
  let link = initialLink;

  if (!link) {
    const syntheticEmail = `hydra-${crypto.randomUUID()}@users.invalid`;
    const { data: created, error: createError } =
      await admin.auth.admin.createUser({
        email: syntheticEmail,
        email_confirm: true,
        user_metadata: { hydra_user_id: hydraUser.id },
      });
    if (createError || !created.user) {
      return json(
        { error: createError?.message ?? "Failed to create user" },
        500
      );
    }
    const inserted = await admin.from("hydra_user_links").insert({
      hydra_user_id: hydraUser.id,
      hydra_email: hydraUser.email ?? null,
      supabase_user_id: created.user.id,
      supabase_email: syntheticEmail,
    });
    if (inserted.error) {
      // A second bridge request may have created the mapping concurrently.
      // Prefer that canonical mapping and remove only our unused auth user.
      const { data: existing, error: existingError } = await admin
        .from("hydra_user_links")
        .select("supabase_user_id,supabase_email")
        .eq("hydra_user_id", hydraUser.id)
        .maybeSingle();
      await admin.auth.admin.deleteUser(created.user.id);
      if (existingError || !existing) {
        return json(
          { error: existingError?.message ?? inserted.error.message },
          500
        );
      }
      link = existing;
    } else {
      link = {
        supabase_user_id: created.user.id,
        supabase_email: syntheticEmail,
      };
    }
  } else if (hydraUser.email) {
    await admin
      .from("hydra_user_links")
      .update({
        hydra_email: hydraUser.email,
        updated_at: new Date().toISOString(),
      })
      .eq("hydra_user_id", hydraUser.id);
  }

  const { data: generated, error: generateError } =
    await admin.auth.admin.generateLink({
      type: "magiclink",
      email: link.supabase_email,
    });
  if (generateError || !generated.properties.hashed_token) {
    return json(
      { error: generateError?.message ?? "Failed to issue session" },
      500
    );
  }

  const authClient = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: verified, error: verifyError } =
    await authClient.auth.verifyOtp({
      token_hash: generated.properties.hashed_token,
      type: "magiclink",
    });
  if (verifyError || !verified.session || !verified.user) {
    return json(
      { error: verifyError?.message ?? "Failed to create session" },
      500
    );
  }

  return json({
    access_token: verified.session.access_token,
    refresh_token: verified.session.refresh_token,
    expires_at: verified.session.expires_at,
    user: { id: verified.user.id },
  });
});
