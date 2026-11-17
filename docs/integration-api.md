# Integration API

Lets another app you run, like an intranet or a CRM, hand SignuDoc a document to sign. The other app starts a draft, its user finishes the draft in SignuDoc, and later the app reads the status and fetches the sealed PDF.

It's off until you set `INTEGRATION_API_KEY` on the install. Use a long random value, for example from `openssl rand -base64 32`. Every request sends it as `Authorization: Bearer <key>`.

What the key can do is limited:

- It only reads envelopes the API created itself. Envelopes people upload in SignuDoc are out of its reach.
- It never sends anything. A draft belongs to an existing, verified SignuDoc account, named by email. That person signs in to SignuDoc, places the fields and signers, and sends the envelope.
- `APP_URL` (or Vercel's own address) is used to build the `url` it returns.

## Start a draft

`POST /api/integrations/envelopes` as `multipart/form-data`:

| field         | required | notes                                               |
| ------------- | -------- | --------------------------------------------------- |
| `file`        | yes      | the PDF. On Vercel the request must be under 4.5 MB |
| `title`       | yes      | up to 160 characters                                |
| `senderEmail` | yes      | a verified SignuDoc account, which owns the draft   |
| `source`      | no       | which app sent it, e.g. `zendera-hq`                |
| `reference`   | no       | the other app's id for the document, returned as is |

Returns `201` with the envelope (see below). `url` is where the sender places the fields. If no verified account has that email, it returns `422`.

## Read an envelope

`GET /api/integrations/envelopes/{id}`

```json
{
  "id": "…",
  "title": "Bank Confirmation Letter - Acme",
  "status": "draft | sent | completed | declined | voided | expired",
  "url": "https://sign.example.com/envelopes/…",
  "reference": "…",
  "senderEmail": "…",
  "completedAt": 1795000000,
  "signers": [
    {
      "name": "…",
      "email": "…",
      "status": "pending | notified | signed | declined",
      "signedAt": null
    }
  ]
}
```

## Download the signed copy

`GET /api/integrations/envelopes/{id}/download?type=signed` returns the sealed PDF. `type=evidence` returns the audit certificate. Both are only available once the envelope is completed.

## Give someone an account

`POST /api/integrations/accounts` as JSON: `{ "email": "...", "name": "..." }`

For people the other app has already confirmed, for example through its own sign-in. An existing account is marked verified and left otherwise alone (`200`, `{"status": "existing"}`). Otherwise a verified account is created with a password nobody knows, and SignuDoc emails the person its reset link so they can choose one (`201`, `{"status": "created"}`). The sign-up rule in Settings doesn't apply, the same as for the administrator made at setup.

## Database

`db/migrations/20261120090000_integration_source.sql` adds `integration_source` and `integration_reference` to `envelopes`. It runs with the other migrations on deploy.
