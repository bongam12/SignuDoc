import { NextResponse } from "next/server";

import {
  getIntegrationEnvelope,
  identifyIntegrationCaller,
  integrationEnvelopeResponse,
} from "@/lib/integrations";

// The status of an envelope the integration API created: draft, sent,
// completed, declined, voided or expired, with each signer.

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function GET(request: Request, context: RouteContext) {
  const caller = identifyIntegrationCaller(
    request.headers.get("authorization"),
  );

  if (caller === "disabled") {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  if (caller === "denied") {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const { id } = await context.params;
  const envelope = await getIntegrationEnvelope(id);

  if (!envelope) {
    return NextResponse.json({ error: "Envelope not found." }, { status: 404 });
  }

  return NextResponse.json(integrationEnvelopeResponse(envelope), {
    headers: { "cache-control": "private, no-store" },
  });
}
