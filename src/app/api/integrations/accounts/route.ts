import { randomBytes } from "node:crypto";

import { NextResponse } from "next/server";
import { z } from "zod";

import { getAuth } from "@/lib/auth/server";
import { runAsSetup } from "@/lib/auth/setup-context";
import { getDb } from "@/lib/db/connection";
import { identifyIntegrationCaller } from "@/lib/integrations";
import { logRouteError } from "@/lib/security/logging";
import { getClientIpAddress, getRequestPathname } from "@/lib/security/request";
import { resolveAppUrl } from "@/lib/utils/env";

// Gives a person from the other app a SignuDoc account they can send from.
// The other app has already confirmed the address (its own sign-in), so the
// account is marked verified, the way first-run setup marks the
// administrator's.
//
// - An account that exists is marked verified and left otherwise alone.
// - A new account gets a random password nobody knows, and the person is
//   emailed SignuDoc's own reset link to choose one before they sign in.
//
// The sign-up rule (which email domains may register) stands aside here for
// the same reason it does during setup: someone with the key is vouching.
//
// application/json: { email, name }

const bodySchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  name: z.string().trim().min(1).max(120),
});

type UserRow = { emailVerified: boolean; id: string };

export async function POST(request: Request) {
  const caller = identifyIntegrationCaller(
    request.headers.get("authorization"),
  );

  if (caller === "disabled") {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  if (caller === "denied") {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request." },
      { status: 400 },
    );
  }

  const { email, name } = parsed.data;
  const database = getDb();

  try {
    const existing = await database.query<UserRow>(
      `SELECT id, "emailVerified" FROM public."user" WHERE lower(email) = $1`,
      [email],
    );
    const user = existing.rows[0];

    if (user) {
      if (!user.emailVerified) {
        await database.query(
          `UPDATE public."user" SET "emailVerified" = true, "updatedAt" = now() WHERE id = $1`,
          [user.id],
        );
      }

      return NextResponse.json({ status: "existing" });
    }

    // Nobody signs in with this password: the reset link below replaces it.
    const password = randomBytes(32).toString("base64url");
    const created = await runAsSetup(() =>
      getAuth().api.signUpEmail({ body: { email, name, password } }),
    );

    await database.query(
      `UPDATE public."user" SET "emailVerified" = true, "updatedAt" = now() WHERE id = $1`,
      [created.user.id],
    );

    const appUrl = resolveAppUrl();

    await getAuth().api.requestPasswordReset({
      body: {
        email,
        redirectTo: appUrl ? new URL("/login", appUrl).toString() : "/login",
      },
    });

    return NextResponse.json({ status: "created" }, { status: 201 });
  } catch (error) {
    logRouteError(error, {
      category: "integration_account_failure",
      ipAddress: getClientIpAddress(request.headers),
      message:
        "Unexpected failure while giving an integration user an account.",
      path: getRequestPathname(request),
    });

    return NextResponse.json(
      { error: "Unable to set up the SignuDoc account." },
      { status: 500 },
    );
  }
}
