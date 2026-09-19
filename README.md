# Corvo Flash

A Telegram social-trading interface for reviewing and confirming wallet-copy signals without taking custody of user funds.

## What is here

This submission contains the Flash social-trading engine, copy-signal flow, advanced-order modules, trade helpers, focused tests, and demo notes. Production credentials, user databases, treasury code, admin controls, deployment files, and runtime state are intentionally excluded.

## Product flow

1. Track a wallet.
2. Receive a signal when it trades.
3. Review the token, amount, route, and risk context.
4. Confirm from the user's own wallet/device.
5. Manage DCA, stop-loss, take-profit, and open orders from Telegram.

## Configuration

The production bot reads credentials from environment variables. No credentials are included in this repository.

## Local checks

```bash
npm install
node --check src/flash-engine.js
node --check src/copy-command.js
node tests/money.test.js
```

## Demo

A recorded demo link will be added to the Runtime submission after upload.
