import assert from "node:assert/strict";
import { it } from "node:test";
import { validateBuildEnvironment } from "./build-environment.js";

const valid = {
  MAIN_VITE_API_URL: "https://api.example.org",
  MAIN_VITE_AUTH_URL: "https://auth.example.org",
  MAIN_VITE_CHECKOUT_URL: "https://checkout.example.org",
};
it("accepts complete Hydra endpoints without an alternative backend", () => {
  assert.doesNotThrow(() => validateBuildEnvironment(valid));
});
it("rejects missing, blank, and malformed endpoints before bundling", () => {
  for (const name of Object.keys(valid)) {
    for (const value of [
      undefined,
      "",
      "  ",
      "not-a-url",
      "file:///tmp/test",
    ]) {
      assert.throws(
        () => validateBuildEnvironment({ ...valid, [name]: value }),
        new RegExp(name)
      );
    }
  }
});
it("rejects Supabase-only configuration that would crash the main process", () => {
  assert.throws(
    () =>
      validateBuildEnvironment({
        MAIN_VITE_SUPABASE_URL: "https://project.example.org",
      }),
    /Missing MAIN_VITE_API_URL/
  );
});
it("requires a complete and matching alternative-backend configuration", () => {
  const backend = {
    MAIN_VITE_SUPABASE_URL: "https://project.example.org",
    MAIN_VITE_SUPABASE_ANON_KEY: "public-key",
    RENDERER_VITE_SUPABASE_URL: "https://project.example.org",
    RENDERER_VITE_SUPABASE_ANON_KEY: "public-key",
  };
  assert.doesNotThrow(() => validateBuildEnvironment({ ...valid, ...backend }));
  for (const name of Object.keys(backend)) {
    assert.throws(
      () => validateBuildEnvironment({ ...valid, ...backend, [name]: "" }),
      new RegExp(name)
    );
  }
  assert.throws(
    () =>
      validateBuildEnvironment({
        ...valid,
        ...backend,
        RENDERER_VITE_SUPABASE_ANON_KEY: "other-key",
      }),
    /must match/
  );
  assert.throws(
    () =>
      validateBuildEnvironment({
        ...valid,
        ...backend,
        RENDERER_VITE_SUPABASE_URL: "https://other.example.org",
      }),
    /must match/
  );
});
