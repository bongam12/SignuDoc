import { NextResponse } from "next/server";
import { z } from "zod";

import { getDb } from "@/lib/db/connection";
import { createDraftEnvelope } from "@/lib/envelopes";
import {
  findIntegrationSender,
  getIntegrationEnvelope,
  identifyIntegrationCaller,
  integrationEnvelopeResponse,
  markIntegrationEnvelope,
} from "@/lib/integrations";
import { envelopeTitleSchema } from "@/lib/schemas/common";
import { logRouteError } from "@/lib/security/logging";
import { getClientIpAddress, getRequestPathname } from "@/lib/security/request";
import { DocumentImportError } from "@/lib/services/document-import";

// Starts a draft from a PDF another app sends, owned by the SignuDoc account
// named in senderEmail. Returns the envelope and the address where that
// person places the fields and sends it. See src/lib/integrations.ts.
//
// multipart/form-data: file (PDF), title, senderEmail, and optionally
// source (which app, e.g. "zendera-hq") and reference (its own id for the
// document, returned as is).

const formSchema = z.object({
  reference: z.string().trim().max(200).optional(),
  senderEmail: z.string().trim().email().max(320),
  source: z.string().trim().min(1).max(60).default("integration"),
  title: envelopeTitleSchema,
});

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

  const formData = await request.formData().catch(() => null);
  const file = formData?.get("file");
  const parsed = formSchema.safeParse({
    reference: formData?.get("reference") || undefined,
    senderEmail: formData?.get("senderEmail"),
    source: formData?.get("source") || undefined,
    title: formData?.get("title"),
  });

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request." },
      { status: 400 },
    );
  }

  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: "A PDF file is required." },
      { status: 400 },
    );
  }

  const database = getDb();
  const sender = await findIntegrationSender(parsed.data.senderEmail, database);

  if (!sender) {
    return NextResponse.json(
      {
        error: `No verified SignuDoc account for ${parsed.data.senderEmail}. Create one and verify its email first.`,
      },
      { status: 422 },
    );
  }

  try {
    const result = await createDraftEnvelope(
      sender.id,
      {
        sourcePdf: {
          body: new Uint8Array(await file.arrayBuffer()),
          contentType: file.type || "application/pdf",
          filename: file.name || `${parsed.data.title}.pdf`,
        },
        title: parsed.data.title,
      },
      { database },
    );

    await markIntegrationEnvelope(
      result.envelope.id,
      parsed.data.source,
      parsed.data.reference ?? null,
      database,
    );

    const envelope = await getIntegrationEnvelope(result.envelope.id, database);

    return NextResponse.json(
      envelope ? integrationEnvelopeResponse(envelope) : null,
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof DocumentImportError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    logRouteError(error, {
      category: "integration_envelope_create_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "Unexpected failure while creating an integration envelope.",
      path: getRequestPathname(request),
      userId: sender.id,
    });

    return NextResponse.json(
      { error: "Unable to create the draft envelope." },
      { status: 500 },
    );
  }
}
