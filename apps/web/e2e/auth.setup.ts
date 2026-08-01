import { test as setup, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { HOME, PERSONAS, signIn, statePath, type Persona } from "./helpers/auth";

// One real sign-in per persona for the whole run; every spec adopts the cookie jar left here
// rather than driving the login form itself. See `as()` in helpers/auth.ts for why.
//
// A separate test per persona, not one loop inside a single test: each gets its own browser
// context, so a failure names the persona that could not sign in instead of failing all three.
for (const persona of Object.keys(PERSONAS) as Persona[]) {
  setup(`sign in as ${persona}`, async ({ page }) => {
    await signIn(page, PERSONAS[persona]);
    // The jar is only worth saving if it actually authenticates: `signIn` waits for any URL off
    // /login, this pins it to the surface the role belongs on.
    await expect(page).toHaveURL(HOME[persona]);

    const path = statePath(persona);
    mkdirSync(dirname(path), { recursive: true });
    await page.context().storageState({ path });
  });
}
