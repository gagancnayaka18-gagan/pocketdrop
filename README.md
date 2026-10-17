PocketDrop 2.0 — 20 MB transfers
A responsive, Vercel-ready website for moving text and small files between devices with a four-digit code. Includes complete frontend, serverless API, Redis storage, and tests. No runtime npm dependencies.
Features
Send text (up to 100,000 characters) and up to five files together, with a 20 MiB combined limit.
Unique codes from 1000–9999, allocated atomically after all chunks arrive; active transfers cannot overwrite one another.
Retrieve from any device with a browser; copy text or download files.
Ten-minute server-side expiry after upload completion, countdown, copy code/link, and sender-only deletion.
Files upload and download in 1 MiB chunks, with progress and one retry for temporary failures.
Incomplete uploads expire after ten minutes; no code is issued for missing chunks.
Responsive layout, drag-and-drop uploads, keyboard-accessible tabs, error messages, and loading states.
Shared Redis storage across Vercel function instances; no browser-only fake transfers.
Deploy on Vercel
Extract this ZIP. Upload the contents of `pocketdrop` to a new GitHub repository. Keep `package.json`, `vercel.json`, `api`, `lib`, and `public` at the repository root. Include `.env.example` and `.gitignore`; never commit real credentials.
Create an Upstash Redis database at https://console.upstash.com/ (or connect Upstash through the Vercel Marketplace). Copy its REST URL and REST token.
At https://vercel.com/new import your repository. Choose Other as the framework preset. The included configuration sets the build command to `npm run build` and output directory to `public`.
Add these environment variables to the Vercel project:
Variable	Value
`UPSTASH_REDIS_REST_URL`	Your Upstash HTTPS REST URL
`UPSTASH_REDIS_REST_TOKEN`	Your Upstash REST token (write-capable)
Keep both on the server. Do not prefix with `NEXT_PUBLIC_` or place in browser code. If your integration uses different variable names, copy their values into these exact names.
Deploy. If variables are added after deployment, redeploy. Open the resulting `.vercel.app` URL on two devices, send text and a file on one, and retrieve with the code on the other.
Check Vercel deployment protection settings if recipients need public access. Set provider usage alerts and appropriate firewall limits before sharing widely.
Alternative: with the Vercel CLI installed, run `vercel` from this folder, add the environment variables in the dashboard, then `vercel --prod`.
Hosting and database plans have usage limits. Confirm current Vercel/Upstash eligibility and pricing; unlimited free hosting is not promised.
Run locally
Use Node.js 22. Copy `.env.example` to `.env.local`, fill in the two Upstash values, then run:
```sh
npm run dev
```
Open http://localhost:3000. No npm install is necessary: the project uses Node built-ins. For cross-device local testing, open your computer's LAN IP on the other device; browser clipboard access may require HTTPS, but manual copying works. The development server binds to your network interfaces. Stop it when finished.
```sh
npm test
npm run build
```
The local server uses the same Redis-backed API as production. Without credentials, the interface loads but sends/receives return a setup error. It never pretends a local-only transfer is successful.
Behavior and privacy
This implements the requested code-based handoff, with original branding and design. Unlike copypaste.me's stated peer-to-peer approach, PocketDrop temporarily stores payloads in Redis. It is not end-to-end encrypted. Production connections use HTTPS. Anyone who guesses or knows an active code can retrieve the contents; four digits provide only 9,000 possibilities. Use for low-sensitivity material, never passwords, secrets, or confidential documents.
Codes expire 10 minutes after upload completion; receiving does not delete a transfer. After expiry, a code can be reused, so always use a freshly shared code. "Send something else" leaves the previous transfer active until expiry; delete it first if desired. Deleting/expiring removes the server record, but cannot remove content already copied/downloaded by a recipient or guarantee immediate removal from provider backups. Reloading the sender page loses its deletion token; expiry still applies.
The API limits each IP per minute to 8 upload initializations, 15 code lookups, 20 commits, 20 deletions, 240 uploaded chunks, and 240 downloaded chunks. Shared networks share these limits. These basic application limits reduce casual guessing, not distributed attacks. Add provider firewall/bot controls for a public high-traffic service. Capacity is 9,000 concurrent codes, with bounded random retries returning a busy message under congestion. No accounts or analytics are included. Files are offered as downloads, never rendered as HTML. Only open files from people you trust.
Files are split into 1 MiB chunks. Each request/response stays below 1.6 MB even after base64 encoding, below Vercel's documented 4.5 MB limit. Each Redis call reads/writes only one chunk or small metadata, below Upstash's documented 10 MB request limit. A 20 MiB file uses about 26.7 MiB of active Redis storage, plus metadata. Stored data, commands, and bandwidth count toward your provider plans. Downloads are reassembled in browser memory.
Upload the full project together. Version 1 transfers are not migrated; let old transfers finish first. Refresh both devices after deploying. The new Redis namespace is `pd:v2:`; never flush a shared database to upgrade. See the ZIP's `UPDATE-STEPS.txt` for the replacement file list and deployment checks.
Structure
`public/` — self-contained frontend and styles
`api/transfer.js` — Vercel function, validation, allocation, retrieval, deletion, rate limiting
`lib/store.js` — authenticated Upstash REST adapter
`lib/protocol.js` — size limits and atomic Redis Lua operations
`dev.mjs` — local HTTP server
`test/transfer.test.js` — backend tests using an injected in-memory Redis stand-in
`vercel.json` — deployment and security headers
Validation and remaining deployment checks
13 automated contract tests cover a complete 20 MiB binary round trip (SHA-256 verified), text and empty files, size limits, chunk validation, missing chunks, sender authorization, retries, immutability after commit, code collisions, expiry, deletion, rate limits, stale clients, and storage failures. They use an in-memory Redis stand-in and do not execute the production Lua scripts against a live Redis database. No live Vercel deployment or two-device browser verification was performed when this package was created; those require your hosting account and database configuration.
Official references:
https://vercel.com/docs/project-configuration/vercel-json
https://vercel.com/docs/functions/limitations
https://upstash.com/docs/redis/features/restapi
https://upstash.com/docs/redis/troubleshooting/max_request_size_exceeded
