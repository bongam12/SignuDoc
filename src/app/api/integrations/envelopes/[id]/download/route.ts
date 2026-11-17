import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { createDownloadResponse } from "@/lib/download-response";
import {
  DownloadAccessError,
  getSenderEnvelopeDownload,
} from "@/lib/downloads";
import {
  getIntegrationEnvelope,
  identifyIntegrationCaller,
} from "@/lib/integrations";
import { logRouteError } from "@/lib/security/logging";
import { getClientIpAddress, getRequestPathname } from "@/lib/security/request";

// The sealed, signed PDF (?type=signed, the default) or the audit
// certificate (?type=evidence) of a completed integration envelope, exactly
// as the sender would download it.

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

  const type = new URL(request.url).searchParams.get("type") ?? "signed";

  try {
    return await createDownloadResponse(
      await getSenderEnvelopeDownload(envelope.userId, id, type),
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return NextResponse.json(
        { error: "type must be signed or evidence." },
        { status: 400 },
      );
    }

    if (error instanceof DownloadAccessError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.statusCode },
      );
    }

    logRouteError(error, {
      category: "integration_download_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "Unexpected failure while downloading an integration envelope.",
      path: getRequestPathname(request),
    });

    return NextResponse.json(
      { error: "Unable to download this file." },
      { status: 500 },
    );
  }
}
