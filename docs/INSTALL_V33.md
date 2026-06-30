# Install V33 overlay

## Option A - Manual copy

Copy these files from this package into the same paths in the current V32/V31 repository:

```text
server/src/connectors/uberConnector.js
server/src/connectors/whatsappConnector.js
server/src/whatsappParser.js
```

Do not copy or modify POS/reporting files.

## Option B - Patch script

From the current deployed repository root, run:

```bash
node /path/to/Freda_Ops_Cockpit_V33_Uber_Whatsapp_Fix/scripts/apply_v33_patch.mjs /path/to/current/freda/repo
```

Then run:

```bash
cd /path/to/current/freda/repo/server
npm run check
```

## Render deployment

Use the same Render settings:

```text
Root Directory: server
Build Command: npm install && npx playwright install chromium
Start Command: node server.js
Health Check Path: /health
```

## Uber checks

Run Uber sync for a selected date and confirm the response no longer returns a false success where all stores have the same `orders` and `sales=0`.

The result is only trusted if at least one store has a real selected-day sales value or if zero sales truly has zero orders.

## WhatsApp checks

Upload the `whatsapp.zip` from the app. V33 should return diagnostics including:

- uploaded filename;
- ZIP entries;
- text source selected;
- message count;
- action count;
- sell-out / leftover / stock / ops actions.

If the ZIP has no chat `.txt`, the response will explain that clearly.
