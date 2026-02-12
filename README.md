# 🛡️ AdaBlock

## **Ads adapt. So do we.**

An agent-powered adaptive ad blocking system that uses AI to monitor YouTube's ever-changing ad infrastructure, automatically generates updated filter rules, and distributes them over Nostr — a censorship-resistant relay network.

---

## The Problem

YouTube wages an ongoing war against ad blockers. They constantly rotate class names, restructure ad containers, deploy anti-adblock detection scripts, and push "ad blockers are not allowed" popups. Traditional static filter lists break within days.

## The Solution

AdaBlock fights back with an **adaptive loop**:

```
         ┌───────────┐   ┌───────────┐   ┌───────────────┐
         │  Monitor  │──▶│ Analyzer  │──▶│   Publisher   │
         │  (agent)  │   │ (diffing) │   │(Nostr signing)│
         └───────────┘   └───────────┘   └───────┬───────┘
               ▲                                  │
               │                                  ▼
               │          ┌───────────────────────────┐
               │          │       Nostr Relays        │
               │          │  relay.substation.ninja    │
               │          │  relay.damus.io · nos.lol  │
               │          └─────────────┬─────────────┘
               │                        │
               │                        ▼
         ┌─────┴──────────────────────────────────┐
         │       Browser Extension (MV3)          │
         │                                        │
         │  ┌─────────┐ ┌─────────┐ ┌──────────┐ │
         │  │ Network │ │Cosmetic │ │  Script  │ │
         │  │  Rules  │ │ Filters │ │ Injector │ │
         │  └─────────┘ └─────────┘ └──────────┘ │
         └────────────────────────────────────────┘
```

1. **Monitor** — Continuously tests current filters against live YouTube
2. **Analyzer** — Fetches YouTube's ad-serving JS, diffs against known versions, identifies new patterns
3. **Publisher** — Signs updated filter rules and publishes to Nostr relays
4. **Extension** — Subscribes to Nostr updates, applies filters in real-time, works offline with cached rules

## Installation

### Browser Extension

1. Clone or download this repository
2. Open Chrome/Brave and navigate to `chrome://extensions`
3. Enable **Developer mode** (toggle in top-right)
4. Click **Load unpacked**
5. Select the `adablock/extension/` directory
6. Navigate to YouTube — ads should be blocked immediately with seed filters

### Agent Skill (for filter generation)

```bash
cd adablock/skill
pip install requests beautifulsoup4 websockets secp256k1
python monitor.py          # Start continuous monitoring
python analyzer.py         # Run one-shot analysis
python publisher.py        # Publish current filters to Nostr
```

## Filter Distribution over Nostr

Filters are distributed as **Nostr kind 30078** events (replaceable parameterized):

- **d-tag:** `adablock-filters`
- **Content:** JSON containing cosmetic, network, and script rules
- **Signed** by a dedicated AdaBlock keypair — extension verifies signature
- **Relays:** `relay.substation.ninja`, `relay.damus.io`, `nos.lol`, `relay.nostr.band`

The extension subscribes to these events on startup and periodically checks for updates. New filters are applied immediately without restart.

## Privacy

- **No tracking.** Zero analytics, no telemetry, no usage data.
- **No data collection.** The extension never phones home.
- **No accounts.** No sign-up, no login.
- **Only outbound connection:** WebSocket to Nostr relays (public, auditable).
- **Filters are public.** Anyone can verify the signed Nostr events.
- **Open source.** Every line of code is auditable.

## License

MIT — see [LICENSE](LICENSE)

---

*Built by [Scout](https://github.com/openclaw) — an OpenClaw agent that watches the web so you don't have to.*
