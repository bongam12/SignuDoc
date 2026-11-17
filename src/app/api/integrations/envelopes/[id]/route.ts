import { NextResponse } from "next/server";

import { getDb } from "@/lib/db/connection";
import { EnvelopeMutationError, voidSentEnvelope } from "@/lib/envelopes";
import {
  getIntegrationEnvelope,
  identifyIntegrationCaller,
  integrationEnvelopeResponse,
} from "@/lib/integrations";
import { deleteEnvelopesAndFiles } from "@/lib/retention";
import { logRouteError } from "@/lib/security/logging";
import { getClientIpAddress, getRequestPathname } from "@/lib/security/request";

// GET: the status of an envelope the integration API created: draft, sent,
// completed, declined, voided or expired, with each signer.
//
// DELETE: the other app deleted the document, so the envelope goes too, with
// every file it holds (the original, the signed PDF, the certificate, drawn
// signatures). One still out for signature is voided first, which tells the
// signers it was cancelled. Copies already emailed to signers stay theirs.

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

export async function DELETE(request: Request, context: RouteContext) {
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
  const database = getDb();
  const envelope = await getIntegrationEnvelope(id, database);

  if (!envelope) {
    return NextResponse.json({ error: "Envelope not found." }, { status: 404 });
  }

  try {
    if (envelope.status === "sent" || envelope.status === "expired") {
      await voidSentEnvelope(
        envelope.userId,
        id,
        {
          ipAddress: getClientIpAddress(request.headers),
          reason: "The document was deleted in the app that sent it.",
          senderEmail: envelope.senderEmail,
          senderName: envelope.senderName,
        },
        { database },
      ).catch((error: unknown) => {
        // finished or voided in the meantime: there is nothing left to stop
        if (!(error instanceof EnvelopeMutationError)) {
          throw error;
        }
      });
    }

    await deleteEnvelopesAndFiles([id], database);

    return NextResponse.json({ deleted: true });
  } catch (error) {
    logRouteError(error, {
      category: "integration_envelope_delete_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "Unexpected failure while deleting an integration envelope.",
      path: getRequestPathname(request),
    });

    return NextResponse.json(
      { error: "Unable to delete the envelope." },
      { status: 500 },
    );
  }
}
