# AdaBlock Filter Format

## Overview

AdaBlock uses a JSON-based filter format distributed via Nostr events. Three types of rules work together:

1. **Cosmetic Rules** — CSS selectors to hide ad elements
2. **Network Rules** — URL patterns to block via declarativeNetRequest
3. **Script Rules** — JavaScript to inject on page for active ad mitigation

## Filter Update Schema

```json
{
  "version": "1.0.1",
  "timestamp": "2026-02-12T00:00:00Z",
  "generated_by": "adablock-analyzer",
  "cosmetic": {
    "name": "YouTube Cosmetic Filters",
    "version": "1.0.1",
    "updated": "2026-02-12T00:00:00Z",
    "rules": [
      {
        "id": "unique-rule-id",
        "selector": ".ytp-ad-overlay-container",
        "description": "Video overlay ad container",
        "discovered": "2026-02-12T00:00:00Z"
      }
    ]
  },
  "network": {
    "name": "YouTube Network Filters",
    "version": "1.0.1",
    "updated": "2026-02-12T00:00:00Z",
    "rules": [
      {
        "id": "unique-rule-id",
        "pattern": "||doubleclick.net",
        "description": "DoubleClick ad network"
      }
    ]
  },
  "scripts": {
    "name": "YouTube Script Injection Rules",
    "version": "1.0.1",
    "updated": "2026-02-12T00:00:00Z",
    "rules": [
      {
        "id": "unique-rule-id",
        "name": "Human-readable name",
        "enabled": true,
        "runAt": "idle",
        "code": "(function(){ /* ... */ })();"
      }
    ]
  }
}
```

## Cosmetic Rules

CSS selectors injected as a `<style>` element that hides matching ad elements.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Unique rule identifier |
| `selector` | string | yes | CSS selector targeting ad element |
| `description` | string | no | Human-readable description |
| `discovered` | ISO 8601 | no | When this pattern was first seen |

**Selector types supported:**
- Tag name: `ytd-ad-slot-renderer`
- Class: `.ytp-ad-overlay-container`
- ID: `#masthead-ad`
- Attribute: `[target-id="engagement-panel-ads"]`
- Pseudo-class: `:has()` (Chrome 105+)

## Network Rules

URL patterns converted to Chrome's `declarativeNetRequest` format for network-level blocking.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Unique rule identifier |
| `pattern` | string | yes | URL filter pattern (AdBlock Plus syntax) |
| `description` | string | no | Human-readable description |

**Pattern syntax:**
- `||domain.com` — Match domain and subdomains
- `*` — Wildcard
- `|` at start/end — Anchor to start/end of URL
- Standard URL string matching

## Script Rules

JavaScript code injected into the page for active ad mitigation (clicking skip buttons, skipping ad segments, etc.).

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Unique rule identifier |
| `name` | string | yes | Human-readable name |
| `enabled` | boolean | yes | Whether to execute this rule |
| `runAt` | string | no | When to run: `"idle"`, `"start"`, `"end"` |
| `code` | string | yes | JavaScript to execute (IIFE recommended) |

## Versioning

Versions follow semver: `MAJOR.MINOR.PATCH`

- **MAJOR** — Breaking format changes
- **MINOR** — New rule categories or fields
- **PATCH** — Rule additions/updates (most common)

## Nostr Event Structure

Filter updates are published as **NIP-78** events (kind 30078, replaceable parameterized).

```json
{
  "id": "<sha256 of serialized event>",
  "pubkey": "<hex public key of signer>",
  "created_at": 1739347200,
  "kind": 30078,
  "tags": [
    ["d", "adablock-filters"],
    ["version", "1.0.1"],
    ["t", "adablock"],
    ["t", "ad-filter"],
    ["t", "youtube"]
  ],
  "content": "<JSON string of filter update>",
  "sig": "<schnorr signature>"
}
```

**Key properties:**
- **Kind 30078** — Replaceable parameterized: newer events with same `d` tag replace older ones
- **d-tag** `"adablock-filters"` — Unique identifier for this event type
- **content** — JSON string containing the full filter update (see schema above)
- **Signature** — Schnorr signature verifiable with the publisher's public key
