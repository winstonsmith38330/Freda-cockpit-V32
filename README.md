# Freda Ops Cockpit V33 - Uber Manager + WhatsApp Parser Fix

This package is a targeted V33 overlay for the current Freda Ops Cockpit deployment.

It fixes:

1. Uber Manager online sync false success where all three stores returned identical values, orders but zero sales, and no hourly rows.
2. WhatsApp `.zip` parsing failure.

It intentionally does not change POS/reporting.site logic.

## Files patched

```text
server/src/connectors/uberConnector.js
server/src/connectors/whatsappConnector.js
server/src/whatsappParser.js
```

## Why POS is not included

The request was to keep POS as it is. For that reason this package only contains the Uber and WhatsApp files that need replacement. The current POS files should remain in the deployed repo.

## Install

See `docs/INSTALL_V33.md`.

## Changelog

See `docs/V33_CHANGELOG.md`.
