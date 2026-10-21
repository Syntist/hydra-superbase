export const isSupabaseCloudConfigured = Boolean(
  import.meta.env.RENDERER_VITE_SUPABASE_URL &&
    import.meta.env.RENDERER_VITE_SUPABASE_ANON_KEY
);
