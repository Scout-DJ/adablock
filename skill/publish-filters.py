#!/usr/bin/env python3
"""
Publish AdaBlock seed filters to Nostr relays as kind 30078 events.
Uses Scout's actual Nostr key for real Schnorr signatures.
"""

import hashlib
import json
import time
import asyncio
from pathlib import Path

import websockets
import secp256k1

SCRIPT_DIR = Path(__file__).parent
EXTENSION_DIR = SCRIPT_DIR.parent / "extension"
SECRET_KEY_PATH = Path.home() / ".clawstr" / "secret.key"

RELAYS = [
    "wss://relay.substation.ninja",
    "wss://relay.damus.io",
    "wss://nos.lol",
    "wss://relay.nostr.band"
]

KIND = 30078
D_TAG = "adablock-filters"


def load_secret_key():
    """Load Scout's Nostr secret key."""
    key_hex = SECRET_KEY_PATH.read_text().strip()
    # Handle nsec or raw hex
    if key_hex.startswith("nsec"):
        # bech32 decode needed - for now assume hex
        raise ValueError("nsec format - convert to hex first")
    return key_hex


def get_pubkey(privkey_hex: str) -> str:
    """Derive public key from private key."""
    sk = secp256k1.PrivateKey(bytes.fromhex(privkey_hex))
    # Get compressed pubkey, strip the 02/03 prefix for Nostr (x-only)
    pubkey_bytes = sk.pubkey.serialize(compressed=True)
    return pubkey_bytes[1:].hex()  # Strip prefix byte


def compute_event_id(pubkey, created_at, kind, tags, content):
    serialized = json.dumps(
        [0, pubkey, created_at, kind, tags, content],
        separators=(",", ":"),
        ensure_ascii=False
    )
    return hashlib.sha256(serialized.encode()).hexdigest()


def sign_event(event_id_hex: str, privkey_hex: str) -> str:
    """Create real Schnorr signature."""
    sk = secp256k1.PrivateKey(bytes.fromhex(privkey_hex))
    # BIP-340 Schnorr signature with "BIP0340/challenge" tag for Nostr
    sig = sk.schnorr_sign(bytes.fromhex(event_id_hex), bip340tag=b'', raw=True)
    return sig.hex()


def load_seed_filters():
    """Load all seed filter files and combine into one update."""
    cosmetic = json.loads((EXTENSION_DIR / "filters/youtube-cosmetic.json").read_text())
    network = json.loads((EXTENSION_DIR / "filters/youtube-network.json").read_text())
    scripts = json.loads((EXTENSION_DIR / "filters/youtube-scripts.json").read_text())

    return {
        "version": "1.0.0",
        "timestamp": int(time.time()),
        "source": "adablock-agent",
        "filters": {
            "cosmetic": cosmetic,
            "network": network,
            "scripts": scripts
        },
        "stats": {
            "cosmetic_count": len(cosmetic.get("rules", [])),
            "network_count": len(network.get("rules", [])),
            "script_count": len(scripts.get("rules", []))
        }
    }


def create_event(filter_data, privkey_hex, pubkey_hex):
    content = json.dumps(filter_data, separators=(",", ":"))
    created_at = int(time.time())
    tags = [
        ["d", D_TAG],
        ["version", filter_data["version"]],
        ["t", "adablock"],
        ["t", "ad-filter"],
        ["t", "youtube"]
    ]

    event_id = compute_event_id(pubkey_hex, created_at, KIND, tags, content)
    sig = sign_event(event_id, privkey_hex)

    return {
        "id": event_id,
        "pubkey": pubkey_hex,
        "created_at": created_at,
        "kind": KIND,
        "tags": tags,
        "content": content,
        "sig": sig
    }


async def publish_to_relay(relay_url, event):
    try:
        async with websockets.connect(relay_url, close_timeout=5) as ws:
            msg = json.dumps(["EVENT", event])
            await ws.send(msg)
            try:
                response = await asyncio.wait_for(ws.recv(), timeout=10)
                data = json.loads(response)
                if data[0] == "OK":
                    if data[2] is True:
                        print(f"  ✅ {relay_url}")
                        return True
                    else:
                        print(f"  ❌ {relay_url}: {data[3] if len(data) > 3 else 'rejected'}")
                        return False
                else:
                    print(f"  ⚠️  {relay_url}: unexpected response {data[0]}")
                    return False
            except asyncio.TimeoutError:
                print(f"  ⏳ {relay_url}: timeout (may still be accepted)")
                return True
    except Exception as e:
        print(f"  ❌ {relay_url}: {e}")
        return False


async def main():
    print("🛡️  AdaBlock Filter Publisher")
    print("=" * 40)

    # Load key
    privkey = load_secret_key()
    pubkey = get_pubkey(privkey)
    print(f"Pubkey: {pubkey[:16]}...")

    # Load filters
    filters = load_seed_filters()
    print(f"Filters: {filters['stats']['cosmetic_count']} cosmetic, "
          f"{filters['stats']['network_count']} network, "
          f"{filters['stats']['script_count']} scripts")

    # Create event
    event = create_event(filters, privkey, pubkey)
    print(f"Event ID: {event['id'][:16]}...")
    print(f"\nPublishing to {len(RELAYS)} relays...")

    # Publish
    tasks = [publish_to_relay(r, event) for r in RELAYS]
    results = await asyncio.gather(*tasks)

    success = sum(1 for r in results if r)
    print(f"\n{'=' * 40}")
    print(f"Published to {success}/{len(RELAYS)} relays")

    # Save pubkey for extension config
    print(f"\nTrusted pubkey for extension: {pubkey}")

    # Update config with pubkey
    config_path = SCRIPT_DIR / "config.json"
    config = json.loads(config_path.read_text())
    if pubkey not in config.get("trusted_pubkeys", []):
        config["trusted_pubkeys"] = [pubkey]
        config_path.write_text(json.dumps(config, indent=2))
        print("Updated config.json with trusted pubkey")


if __name__ == "__main__":
    asyncio.run(main())
