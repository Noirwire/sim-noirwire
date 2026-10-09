# Security

This service never touches a real-money network and never holds a real key. It simulates a test-network order book so the terminal has prices and a tape to show. Still, its fund endpoint and its dev trading routes are a kind of money (test dollars), and its honesty rules (labelling bot activity as bot activity) matter to anyone reading the numbers it reports.

## Reporting a vulnerability

Email **ph1l1ph@proton.me**.

Include what you found, how to reproduce it, and what it lets an attacker do. Please do not open a public issue.

You will get an acknowledgement, and we will keep you informed while we work on a fix.

## What matters most

- A way to get more than one fund grant per address, or past its per-IP limit.
- A way to make the dev trading routes (`/v1/dev/*`) register, or answer, when the service is not running with `VENUE=memory` and `DEV_TRADING=1`.
- A way to make bot volume, bot trader counts or bot fills appear as user activity in a response, or to merge the two.
- A way to make a stale price pass an exposure-increasing order or a liquidation.
- Anything that crashes the process from an external request (an unhandled input, a malformed body, a failed price poll).
