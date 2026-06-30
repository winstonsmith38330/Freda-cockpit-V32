# Freda Ops Cockpit V33 - Uber + WhatsApp Fix

## Scope

V33 is a targeted overlay patch. It does not change the POS/reporting.site connector.

Patched files only:

- `server/src/connectors/uberConnector.js`
- `server/src/connectors/whatsappConnector.js`
- `server/src/whatsappParser.js`

## Uber fixes

V32 diagnostics showed `status=success`, `periodMatched=true`, but all three stores returned the same `orders=22`, `sales=0`, `hourlyRows=[]` and the same attempted URL/store context. V33 changes the connector so this failure mode is rejected instead of silently accepted.

V33 adds:

- visible store-name selection for Uber Manager;
- per-store diagnostic steps;
- page preview and runtime JSON candidate capture;
- selected-date URL forcing;
- extraction from visible text and runtime JSON;
- rejection of `orders > 0 && sales == 0` unless `UBER_ALLOW_ZERO_SALES_WITH_ORDERS=true`;
- repeated-metric guard when all stores return identical values;
- explicit diagnostics for same configured Uber store IDs.

## WhatsApp fixes

The WhatsApp parser is rebuilt to accept common iPhone and Android exports:

- `.txt` exports;
- `.zip` exports with `_chat.txt` in nested folders;
- UTF-8, UTF-8 BOM, UTF-16LE and UTF-16BE text;
- bracketed iPhone format: `[22/06/2026, 09:13:20] Name: message`;
- Android format: `22/06/2026, 9:13 am - Name: message`;
- multi-line messages;
- media placeholders such as `image omitted`;
- sell-out, leftover, stock and ops/training signals;
- products and rough quantities when visible in message text.

If the ZIP contains no `.txt` chat export, V33 returns the ZIP entry list in diagnostics instead of failing silently.

## Render build

Use the same Render configuration as the current package:

- Root Directory: `server`
- Build Command: `npm install && npx playwright install chromium`
- Start Command: `node server.js`
- Health Check Path: `/health`

## Validation endpoints

After deploying V33:

- `/api/diagnostics/uber`
- `/api/sync/uber`
- `/api/diagnostics/connectors`
- `/api/sync/whatsapp`
- `/api/uploads`

## Important

Do not remove the POS environment variables and do not replace POS connector files. V33 intentionally leaves POS unchanged.
