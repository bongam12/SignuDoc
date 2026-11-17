import { createHash, timingSafeEqual } from "node:crypto";

import {
  getDb,
  queryMany,
  queryOne,
  type DbExecutor,
} from "./db/connection.ts";
import { isEnvelopeExpired } from "./envelope-deadline.ts";
import { readEnv, resolveAppUrl, type EnvSource } from "./utils/env.ts";

// The integration API: lets another app you run (an intranet, a CRM) start a
// draft from one of its documents, send its user to place the fields, and
// later read the status and fetch the sealed PDF.
//
// It is off unless INTEGRATION_API_KEY is set. The key is presented as a
// bearer token and can only touch envelopes the API created itself, which
// carry an integration_source. Drafts are owned by an existing, verified
// SignuDoc account, named by email, so the person still signs in to
// SignuDoc to place fields and send; the key never sends anything itself.

export type IntegrationCaller = "authorized" | "denied" | "disabled";

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export function identifyIntegrationCaller(
  authorizationHeader: string | null,
  env: EnvSource = process.env,
): IntegrationCaller {
  const key = readEnv(env, "INTEGRATION_API_KEY");

  if (!key) {
    return "disabled";
  }

  const presented = /^Bearer (.+)$/.exec(authorizationHeader ?? "")?.[1];

  if (!presented) {
    return "denied";
  }

  return timingSafeEqual(digest(presented), digest(key))
    ? "authorized"
    : "denied";
}

export type IntegrationSender = {
  email: string;
  id: string;
};

/** A SignuDoc account that may send, found by its email address. */
export async function findIntegrationSender(
  email: string,
  database: DbExecutor = getDb(),
): Promise<IntegrationSender | null> {
  return queryOne<IntegrationSender>(
    database,
    `
      SELECT id, email
      FROM public."user"
      WHERE lower(email) = lower($1)
        AND "emailVerified" = true
    `,
    [email.trim()],
  );
}

export async function markIntegrationEnvelope(
  envelopeId: string,
  source: string,
  reference: string | null,
  database: DbExecutor = getDb(),
): Promise<void> {
  await database.query(
    `
      UPDATE envelopes
      SET integration_source = $2, integration_reference = $3
      WHERE id = $1
    `,
    [envelopeId, source, reference],
  );
}

export type IntegrationEnvelopeStatus =
  "completed" | "declined" | "draft" | "expired" | "sent" | "voided";

export type IntegrationEnvelope = {
  completedAt: number | null;
  id: string;
  reference: string | null;
  senderEmail: string;
  signers: Array<{
    email: string;
    name: string;
    signedAt: number | null;
    status: string;
  }>;
  status: IntegrationEnvelopeStatus;
  title: string;
  url: string | null;
  userId: string;
};

type EnvelopeRow = {
  completedAt: string | number | null;
  expiresAt: string | number | null;
  id: string;
  reference: string | null;
  senderEmail: string;
  status: string;
  title: string;
  userId: string;
};

type SignerRow = {
  email: string;
  name: string;
  signedAt: string | number | null;
  status: string;
};

function toNumber(value: string | number | null): number | null {
  return value === null ? null : Number(value);
}

/** Where the sender continues in SignuDoc: placing fields, or the envelope. */
export function integrationEnvelopeUrl(
  envelopeId: string,
  status: string,
  env: EnvSource = process.env,
): string | null {
  const appUrl = resolveAppUrl(env);

  if (!appUrl) {
    return null;
  }

  const path =
    status === "draft"
      ? `/envelopes/${envelopeId}/signers`
      : `/envelopes/${envelopeId}`;

  return new URL(path, appUrl).toString();
}

/** An envelope the API created, or null for any other envelope. */
export async function getIntegrationEnvelope(
  envelopeId: string,
  database: DbExecutor = getDb(),
): Promise<IntegrationEnvelope | null> {
  const envelope = await queryOne<EnvelopeRow>(
    database,
    `
      SELECT
        e.id,
        e.title,
        e.status,
        e.user_id AS "userId",
        e.completed_at AS "completedAt",
        e.expires_at AS "expiresAt",
        e.integration_reference AS "reference",
        u.email AS "senderEmail"
      FROM envelopes e
      JOIN public."user" u ON u.id = e.user_id
      WHERE e.id = $1
        AND e.integration_source IS NOT NULL
    `,
    [envelopeId],
  );

  if (!envelope) {
    return null;
  }

  const signers = await queryMany<SignerRow>(
    database,
    `
      SELECT name, email, status, signed_at AS "signedAt"
      FROM signers
      WHERE envelope_id = $1
      ORDER BY sign_order
    `,
    [envelopeId],
  );
  const now = Math.floor(Date.now() / 1000);
  const status = isEnvelopeExpired(
    { expiresAt: toNumber(envelope.expiresAt), status: envelope.status },
    now,
  )
    ? "expired"
    : (envelope.status as IntegrationEnvelopeStatus);

  return {
    completedAt: toNumber(envelope.completedAt),
    id: envelope.id,
    reference: envelope.reference,
    senderEmail: envelope.senderEmail,
    signers: signers.map((signer) => ({
      email: signer.email,
      name: signer.name,
      signedAt: toNumber(signer.signedAt),
      status: signer.status,
    })),
    status,
    title: envelope.title,
    url: integrationEnvelopeUrl(envelope.id, envelope.status),
    userId: envelope.userId,
  };
}

/** The JSON the API returns: everything but the owner's internal id. */
export function integrationEnvelopeResponse(envelope: IntegrationEnvelope) {
  return {
    completedAt: envelope.completedAt,
    id: envelope.id,
    reference: envelope.reference,
    senderEmail: envelope.senderEmail,
    signers: envelope.signers,
    status: envelope.status,
    title: envelope.title,
    url: envelope.url,
  };
}
