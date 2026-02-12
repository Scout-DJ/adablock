#!/usr/bin/env python3
"""
AdaBlock Publisher — Signs and publishes filter updates to Nostr relays
as kind 30078 (replaceable parameterized) events.
"""

import hashlib
import json
import os
import secrets
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

try:
    import websockets
    import asyncio
except ImportError:
    print("Install dependencies: pip install websockets")
    sys.exit(1)

SCRIPT_DIR = Path(__file__).parent
CONFIG_PATH = SCRIPT_DIR / "config.json"
OUTPUT_DIR = SCRIPT_DIR / "output"

NOSTR_KIND_REPLACEABLE_PARAM = 30078
D_TAG = "adablock-filters"


def load_config():
    with open(CONFIG_PATH) as f:
        return json.load(f)


def generate_keypair():
    """Generate a new Nostr keypair (simplified — uses random bytes as private key)."""
    private_key = secrets.token_hex(32)
    # In production, derive public key using secp256k1 Schnorr
    # For now, use SHA-256 hash as placeholder pubkey
    public_key = hashlib.sha256(bytes.fromhex(private_key)).hexdigest()

    print(f"Private key (hex): {private_key}")
    print(f"Public key (hex):  {public_key}")
    print("\nAdd these to config.json under nostr_keypair")
    print("WARNING: Store private key securely! Never commit to git.")

    return private_key, public_key


def compute_event_id(pubkey: str, created_at: int, kind: int, tags: list, content: str) -> str:
    """Compute Nostr event ID (SHA-256 of serialized event)."""
    serialized = json.dumps(
        [0, pubkey, created_at, kind, tags, content],
        separators=(",", ":"),
        ensure_ascii=False
    )
    return hashlib.sha256(serialized.encode()).hexdigest()


def sign_event(event_id: str, private_key_hex: str) -> str:
    """
    Sign event with Schnorr signature.
    Uses secp256k1/coincurve if available, otherwise falls back to HMAC placeholder.
    """
    try:
        from coincurve import PrivateKey
        sk = PrivateKey(bytes.fromhex(private_key_hex))
        sig = sk.sign_schnorr(bytes.fromhex(event_id))
        return sig.hex()
    except ImportError:
        pass

    try:
        import secp256k1
        sk = secp256k1.PrivateKey(bytes.fromhex(private_key_hex))
        sig = sk.schnorr_sign(bytes.fromhex(event_id))
        return sig.hex()
    except (ImportError, AttributeError):
        pass

    # Fallback: HMAC-based placeholder (NOT valid Schnorr — for development only)
    import hmac
    sig = hmac.new(
        bytes.fromhex(private_key_hex),
        bytes.fromhex(event_id),
        hashlib.sha256
    ).hexdigest()
    # Pad to 128 hex chars (64 bytes) to match Schnorr sig length
    return (sig * 2)[:128]


def create_event(filter_data: dict, private_key_hex: str, public_key_hex: str) -> dict:
    """Create a signed Nostr event for filter update."""
    content = json.dumps(filter_data, separators=(",", ":"))
    created_at = int(time.time())
    tags = [
        ["d", D_TAG],
        ["version", filter_data.get("version", "unknown")],
        ["t", "adablock"],
        ["t", "ad-filter"],
        ["t", "youtube"]
    ]

    event_id = compute_event_id(public_key_hex, created_at, NOSTR_KIND_REPLACEABLE_PARAM, tags, content)
    sig = sign_event(event_id, private_key_hex)

    return {
        "id": event_id,
        "pubkey": public_key_hex,
        "created_at": created_at,
        "kind": NOSTR_KIND_REPLACEABLE_PARAM,
        "tags": tags,
        "content": content,
        "sig": sig
    }


async def publish_to_relay(relay_url: str, event: dict, timeout: float = 15.0) -> bool:
    """Publish an event to a single Nostr relay."""
    try:
        async with websockets.connect(relay_url, close_timeout=5) as ws:
            msg = json.dumps(["EVENT", event])
            await ws.send(msg)

            # Wait for OK response
            try:
                response = await asyncio.wait_for(ws.recv(), timeout=timeout)
                data = json.loads(response)
                if data[0] == "OK" and data[2] is True:
                    print(f"  ✓ Published to {relay_url}")
                    return True
                else:
                    print(f"  ✗ Rejected by {relay_url}: {data}")
                    return False
            except asyncio.TimeoutError:
                print(f"  ? Timeout from {relay_url} (event may still be accepted)")
                return True  # Optimistic
    except Exception as e:
        print(f"  ✗ Error publishing to {relay_url}: {e}")
        return False


async def publish_to_all_relays(event: dict, relays: list[str]) -> dict:
    """Publish event to all configured relays."""
    results = {}
    tasks = [publish_to_relay(relay, event) for relay in relays]
    outcomes = await asyncio.gather(*tasks, return_exceptions=True)

    for relay, outcome in zip(relays, outcomes):
        if isinstance(outcome, Exception):
            results[relay] = False
            print(f"  ✗ Exception for {relay}: {outcome}")
        else:
            results[relay] = outcome

    return results


def get_latest_update() -> dict | None:
    """Get the latest filter update from output directory."""
    if not OUTPUT_DIR.exists():
        return None

    files = sorted(OUTPUT_DIR.glob("filter-update-*.json"), reverse=True)
    if not files:
        return None

    with open(files[0]) as f:
        return json.load(f)


def publish(filter_data: dict = None):
    """Main publish function."""
    config = load_config()

    if filter_data is None:
        filter_data = get_latest_update()
        if filter_data is None:
            print("[AdaBlock Publisher] No filter update found. Run analyzer.py first.")
            return False

    keypair = config.get("nostr_keypair", {})
    private_key = keypair.get("private_key_hex", "")
    public_key = keypair.get("public_key_hex", "")

    if not private_key or private_key == "GENERATE_ME":
        print("[AdaBlock Publisher] No keypair configured. Generating one...")
        private_key, public_key = generate_keypair()
        print("\nUpdate config.json with the keys above, then re-run.")
        return False

    print(f"[AdaBlock Publisher] Publishing filter update v{filter_data.get('version', '?')}")
    print(f"  Pubkey: {public_key[:16]}...")
    print(f"  Relays: {len(config['relays'])}")

    event = create_event(filter_data, private_key, public_key)
    print(f"  Event ID: {event['id'][:16]}...")

    results = asyncio.run(publish_to_all_relays(event, config["relays"]))

    success = sum(1 for v in results.values() if v)
    total = len(results)
    print(f"\n  Published to {success}/{total} relays")

    return success > 0


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--keygen":
        generate_keypair()
    else:
        publish()
