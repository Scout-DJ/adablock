#!/usr/bin/env python3
"""
AdaBlock Monitor — Continuously tests current filters against live YouTube,
detects breakage, and triggers the analyzer when filters stop working.
"""

import json
import logging
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

try:
    import requests
    from bs4 import BeautifulSoup
except ImportError:
    print("Install dependencies: pip install requests beautifulsoup4")
    sys.exit(1)

SCRIPT_DIR = Path(__file__).parent
CONFIG_PATH = SCRIPT_DIR / "config.json"
LOG_DIR = SCRIPT_DIR / "logs"
FILTERS_DIR = SCRIPT_DIR.parent / "extension" / "filters"

# Setup logging
LOG_DIR.mkdir(parents=True, exist_ok=True)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler(LOG_DIR / f"monitor-{datetime.now().strftime('%Y-%m-%d')}.log")
    ]
)
log = logging.getLogger("adablock-monitor")

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
}


def load_config():
    with open(CONFIG_PATH) as f:
        return json.load(f)


def load_filters():
    """Load current filter rules."""
    filters = {}
    for name in ["youtube-cosmetic.json", "youtube-network.json", "youtube-scripts.json"]:
        path = FILTERS_DIR / name
        if path.exists():
            with open(path) as f:
                filters[name] = json.load(f)
    return filters


def fetch_page(url: str) -> str:
    resp = requests.get(url, headers=HEADERS, timeout=30)
    resp.raise_for_status()
    return resp.text


def check_cosmetic_coverage(html: str, cosmetic_filters: dict) -> dict:
    """Check if known ad selectors are still present in the page."""
    soup = BeautifulSoup(html, "html.parser")
    results = {"covered": 0, "missing": 0, "new_suspicious": []}

    rules = cosmetic_filters.get("rules", [])
    for rule in rules:
        selector = rule.get("selector", "")
        if not selector:
            continue
        try:
            # CSS selector matching on server-rendered HTML
            matches = soup.select(selector)
            if matches:
                results["covered"] += 1
        except Exception:
            pass  # Some selectors may not be valid for BS4

    # Look for new suspicious elements not in our filters
    known_selectors = {r.get("selector", "") for r in rules}
    ad_patterns = [
        r'class="[^"]*(?:ad[-_]|sponsor|promo)[^"]*"',
        r'id="[^"]*(?:ad[-_]|player-ads|masthead-ad)[^"]*"',
    ]
    for pattern in ad_patterns:
        for match in re.finditer(pattern, html):
            value = match.group(0)
            if not any(sel in value for sel in known_selectors):
                results["new_suspicious"].append(value[:100])

    return results


def check_anti_adblock_presence(html: str) -> dict:
    """Check if anti-adblock mechanisms are present in the page."""
    indicators = load_config().get("ad_indicators", {}).get("text_patterns", [])
    results = {"detected": False, "patterns": []}

    html_lower = html.lower()
    for pattern in indicators:
        if pattern.lower() in html_lower:
            results["detected"] = True
            results["patterns"].append(pattern)

    # Check for enforcement-related JS
    enforcement_patterns = [
        "enforcement",
        "adBlockerDetected",
        "adblock_detected",
        "showAdBlockMessage",
        "adBlockOverlay",
    ]
    for pattern in enforcement_patterns:
        if pattern in html:
            results["detected"] = True
            results["patterns"].append(f"js:{pattern}")

    return results


def check_ad_script_changes(html: str) -> dict:
    """Check if ad-serving script URLs have changed."""
    soup = BeautifulSoup(html, "html.parser")
    results = {"scripts_found": 0, "player_scripts": [], "ad_scripts": []}

    for script in soup.find_all("script", src=True):
        src = script["src"]
        results["scripts_found"] += 1
        if "player" in src or "base.js" in src:
            results["player_scripts"].append(src)
        if "pagead" in src or "ad" in src.split("/")[-1]:
            results["ad_scripts"].append(src)

    return results


def run_check(config: dict) -> dict:
    """Run a single monitoring check against all endpoints."""
    results = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "endpoints": {},
        "breakage_detected": False,
        "new_patterns_found": False,
        "summary": {}
    }

    filters = load_filters()
    cosmetic = filters.get("youtube-cosmetic.json", {})
    total_suspicious = 0
    anti_adblock_count = 0

    for endpoint in config["youtube_endpoints"]:
        log.info(f"Checking: {endpoint}")
        endpoint_result = {"status": "ok", "checks": {}}

        try:
            html = fetch_page(endpoint)

            # Check 1: Cosmetic filter coverage
            coverage = check_cosmetic_coverage(html, cosmetic)
            endpoint_result["checks"]["cosmetic"] = coverage
            total_suspicious += len(coverage.get("new_suspicious", []))

            # Check 2: Anti-adblock presence
            anti_adblock = check_anti_adblock_presence(html)
            endpoint_result["checks"]["anti_adblock"] = anti_adblock
            if anti_adblock["detected"]:
                anti_adblock_count += 1

            # Check 3: Script changes
            script_changes = check_ad_script_changes(html)
            endpoint_result["checks"]["scripts"] = script_changes

            log.info(f"  Coverage: {coverage['covered']} selectors matched")
            log.info(f"  Suspicious new elements: {len(coverage.get('new_suspicious', []))}")
            log.info(f"  Anti-adblock detected: {anti_adblock['detected']}")
            log.info(f"  Player scripts: {len(script_changes['player_scripts'])}")

        except Exception as e:
            endpoint_result["status"] = "error"
            endpoint_result["error"] = str(e)
            log.error(f"  Error: {e}")

        results["endpoints"][endpoint] = endpoint_result

    # Determine if breakage detected
    if total_suspicious > 5:
        results["new_patterns_found"] = True
        log.warning(f"New suspicious patterns found: {total_suspicious}")

    if anti_adblock_count > 0:
        results["breakage_detected"] = True
        log.warning(f"Anti-adblock detected on {anti_adblock_count} endpoints")

    results["summary"] = {
        "endpoints_checked": len(config["youtube_endpoints"]),
        "new_suspicious_elements": total_suspicious,
        "anti_adblock_endpoints": anti_adblock_count
    }

    return results


def trigger_analyzer():
    """Trigger the analyzer to generate updated filters."""
    log.info("Triggering analyzer...")
    try:
        from analyzer import analyze
        update = analyze()
        if update:
            log.info(f"Analyzer produced update v{update.get('version', '?')}")
            return update
    except Exception as e:
        log.error(f"Analyzer failed: {e}")
    return None


def trigger_publisher(filter_data: dict):
    """Trigger the publisher to distribute updated filters."""
    log.info("Triggering publisher...")
    try:
        from publisher import publish
        success = publish(filter_data)
        if success:
            log.info("Published successfully")
        else:
            log.warning("Publishing failed")
    except Exception as e:
        log.error(f"Publisher failed: {e}")


def monitor_loop():
    """Main monitoring loop."""
    config = load_config()
    interval = config.get("check_interval_minutes", 60) * 60  # seconds

    log.info("=" * 60)
    log.info("AdaBlock Monitor starting")
    log.info(f"Check interval: {interval // 60} minutes")
    log.info(f"Endpoints: {len(config['youtube_endpoints'])}")
    log.info("=" * 60)

    while True:
        try:
            results = run_check(config)

            # Save results
            results_file = LOG_DIR / f"check-{datetime.now().strftime('%Y%m%d-%H%M%S')}.json"
            with open(results_file, "w") as f:
                json.dump(results, f, indent=2)

            # If breakage detected, trigger analysis + publishing
            if results["breakage_detected"] or results["new_patterns_found"]:
                log.warning("Breakage or new patterns detected — triggering update pipeline")
                update = trigger_analyzer()
                if update:
                    trigger_publisher(update)
            else:
                log.info("All checks passed — filters working correctly")

        except Exception as e:
            log.error(f"Monitor loop error: {e}")

        log.info(f"Next check in {interval // 60} minutes")
        time.sleep(interval)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--once":
        config = load_config()
        results = run_check(config)
        print(json.dumps(results, indent=2))
    else:
        monitor_loop()
