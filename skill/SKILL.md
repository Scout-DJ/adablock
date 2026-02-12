# AdaBlock Agent Skill

## Name
`adablock`

## Description
Monitors YouTube's ad-serving infrastructure for changes, generates updated filter rules, and publishes them to Nostr relays for distribution to the AdaBlock browser extension.

## Trigger
- Scheduled: Every 60 minutes
- On-demand: When breakage is reported or detected
- Reactive: When YouTube pushes frontend updates

## Workflow

1. **Monitor** (`monitor.py`) — Check if current filters still work against live YouTube
2. **Analyze** (`analyzer.py`) — If breakage detected, fetch and diff YouTube's ad JS
3. **Generate** — Produce updated cosmetic, network, and script filter rules
4. **Publish** (`publisher.py`) — Sign and publish to Nostr relays as kind 30078

## Dependencies
- Python 3.10+
- `requests` — HTTP client
- `beautifulsoup4` — HTML parsing
- `websockets` — Nostr relay communication
- `secp256k1` or `coincurve` — Schnorr signing (optional, falls back to hashlib)

## Configuration
See `config.json` for relay list, check intervals, trusted pubkeys, and endpoints.

## Output
- Filter update JSON files in `./output/`
- Nostr events published to configured relays
- Logs in `./logs/`
