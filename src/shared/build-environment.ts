type BuildEnvironment = Record<string, string | undefined>;

export function validateBuildEnvironment(environment: BuildEnvironment) {
  for (const name of [
    "MAIN_VITE_API_URL",
    "MAIN_VITE_AUTH_URL",
    "MAIN_VITE_CHECKOUT_URL",
  ]) {
    const value = environment[name]?.trim();
    if (!value) {
      throw new Error(
        `Missing ${name}. Copy .env.example to .env.local and configure the Hydra endpoints before building.`
      );
    }
    assertHttpUrl(name, value);
  }
  const supabaseNames = [
    "MAIN_VITE_SUPABASE_URL",
    "MAIN_VITE_SUPABASE_ANON_KEY",
    "RENDERER_VITE_SUPABASE_URL",
    "RENDERER_VITE_SUPABASE_ANON_KEY",
  ];
  if (supabaseNames.some((name) => environment[name]?.trim())) {
    for (const name of supabaseNames) {
      if (!environment[name]?.trim()) {
        throw new Error(
          `Missing ${name}: configure Supabase in both the main process and renderer.`
        );
      }
    }
    assertHttpUrl(
      "MAIN_VITE_SUPABASE_URL",
      environment.MAIN_VITE_SUPABASE_URL!
    );
    if (
      environment.MAIN_VITE_SUPABASE_URL !==
        environment.RENDERER_VITE_SUPABASE_URL ||
      environment.MAIN_VITE_SUPABASE_ANON_KEY !==
        environment.RENDERER_VITE_SUPABASE_ANON_KEY
    ) {
      throw new Error(
        "Supabase main-process and renderer settings must match."
      );
    }
  }
}

function assertHttpUrl(name: string, value: string) {
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || !url.hostname)
      throw new Error();
  } catch {
    throw new Error(`Invalid ${name}: expected an HTTP(S) URL.`);
  }
}
