import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getCloudSaveAccessAction } from "./cloud-save-access.js";

describe("cloud save access", () => {
  it("sends unauthenticated users to sign in", () => {
    assert.equal(getCloudSaveAccessAction(false, false), "sign-in");
  });

  it("sends authenticated users without a subscription to the paywall", () => {
    assert.equal(getCloudSaveAccessAction(true, false), "paywall");
  });

  it("opens cloud saves only for active subscribers", () => {
    assert.equal(getCloudSaveAccessAction(true, true), "open");
  });

  it("opens an alternative backend only for authenticated users", () => {
    assert.equal(getCloudSaveAccessAction(true, false, true), "open");
    assert.equal(getCloudSaveAccessAction(false, false, true), "sign-in");
  });
});

it("covers every authentication, subscription, and backend combination", () => {
  for (const authenticated of [false, true]) {
    for (const subscribed of [false, true]) {
      for (const alternative of [false, true]) {
        assert.equal(
          getCloudSaveAccessAction(authenticated, subscribed, alternative),
          !authenticated
            ? "sign-in"
            : subscribed || alternative
              ? "open"
              : "paywall"
        );
      }
    }
  }
});
