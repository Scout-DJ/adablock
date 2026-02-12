#!/usr/bin/env python3
"""
AdaBlock Analyzer — Fetches YouTube's ad-serving JavaScript, diffs against
last-known version, identifies new ad patterns, and generates updated filter rules.
"""

import hashlib
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from difflib import unified_diff

try:
    import requests
    from bs4 import BeautifulSoup
except ImportError:
    print("Install dependencies: pip install requests beautifulsoup4")
    sys.exit(1)

# Paths
SCRIPT_DIR = Path(__file__).parent
CONFIG_PATH = SCRIPT_DIR / "config.json"
CACHE_DIR = SCRIPT_DIR / "cache"
OUTPUT_DIR = SCRIPT_DIR / "output"
FILTERS_DIR = SCRIPT_DIR.parent / "extension" / "filters"

# Known patterns that indicate ad-related code
AD_PATTERN_REGEXES = [
    # CSS class names used for ads
    r'(?:class(?:Name)?[=:]\s*["\'])([^"\']*(?:ad[-_]|sponsor|promo|banner)[^"\']*)["\']',
    # Element IDs for ad containers
    r'(?:id[=:]\s*["\'])([^"\']*(?:ad[-_]|player-ads|masthead-ad|ad-slot)[^"\']*)["\']',
    # Ad-related function/variable names
    r'(?:function|var|let|const)\s+((?:ad|Ad|AD)[A-Za-z_]+)',
    # YouTube-specific ad class patterns
    r'(ytp-ad-[a-zA-Z-]+)',
    r'(ytd-(?:ad|promoted|banner|display-ad|in-feed-ad)[a-zA-Z-]*-renderer)',
    # Enforcement/anti-adblock patterns
    r'(enforcement[A-Za-z_-]*)',
    r'(adblock(?:er)?[A-Za-z_-]*)',
    # Ad URL patterns
    r'["\'](/(?:pagead|ptracking|ad_companion|get_midroll)[^"\']*)["\']',
]

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
}


def load_config():
    with open(CONFIG_PATH) as f:
        return json.load(f)


def ensure_dirs():
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)


def fetch_page(url: str) -> str:
    """Fetch a URL and return HTML content."""
    resp = requests.get(url, headers=HEADERS, timeout=30)
    resp.raise_for_status()
    return resp.text


def extract_script_urls(html: str, base_url: str = "https://www.youtube.com") -> list[str]:
    """Extract JavaScript source URLs from HTML."""
    soup = BeautifulSoup(html, "html.parser")
    urls = []
    for script in soup.find_all("script", src=True):
        src = script["src"]
        if src.startswith("//"):
            src = "https:" + src
        elif src.startswith("/"):
            src = base_url + src
        urls.append(src)
    return urls


def fetch_scripts(urls: list[str]) -> dict[str, str]:
    """Fetch JavaScript files and return {url: content}."""
    scripts = {}
    for url in urls:
        try:
            resp = requests.get(url, headers=HEADERS, timeout=30)
            if resp.status_code == 200:
                scripts[url] = resp.text
        except Exception as e:
            print(f"  Failed to fetch {url}: {e}")
    return scripts


def compute_hash(content: str) -> str:
    return hashlib.sha256(content.encode()).hexdigest()[:16]


def load_cached_scripts() -> dict:
    """Load previously cached script hashes and content."""
    cache_file = CACHE_DIR / "scripts_cache.json"
    if cache_file.exists():
        with open(cache_file) as f:
            return json.load(f)
    return {}


def save_cached_scripts(cache: dict):
    cache_file = CACHE_DIR / "scripts_cache.json"
    with open(cache_file, "w") as f:
        json.dump(cache, f, indent=2)


def extract_ad_patterns(content: str) -> dict:
    """Extract ad-related patterns from JavaScript content."""
    patterns = {
        "css_classes": set(),
        "element_ids": set(),
        "functions": set(),
        "url_patterns": set(),
        "ytp_classes": set(),
        "renderers": set(),
        "enforcement": set(),
    }

    for regex in AD_PATTERN_REGEXES:
        for match in re.finditer(regex, content):
            value = match.group(1)
            if "ytp-ad-" in value:
                patterns["ytp_classes"].add(value)
            elif "renderer" in value:
                patterns["renderers"].add(value)
            elif "enforcement" in value.lower() or "adblock" in value.lower():
                patterns["enforcement"].add(value)
            elif value.startswith("/") or value.startswith("http"):
                patterns["url_patterns"].add(value)
            elif re.match(r'^[a-z]', value) and '-' in value:
                patterns["css_classes"].add(value)
            elif re.match(r'^[A-Z]|^ad', value):
                patterns["functions"].add(value)
            else:
                patterns["css_classes"].add(value)

    # Convert sets to sorted lists
    return {k: sorted(v) for k, v in patterns.items()}


def diff_patterns(old_patterns: dict, new_patterns: dict) -> dict:
    """Find new patterns not in the old set."""
    diff = {}
    for key in new_patterns:
        old_set = set(old_patterns.get(key, []))
        new_set = set(new_patterns[key])
        added = new_set - old_set
        if added:
            diff[key] = sorted(added)
    return diff


def load_current_filters() -> dict:
    """Load current filter files."""
    filters = {}
    for name in ["youtube-cosmetic.json", "youtube-network.json", "youtube-scripts.json"]:
        path = FILTERS_DIR / name
        if path.exists():
            with open(path) as f:
                filters[name] = json.load(f)
    return filters


def generate_cosmetic_rules(new_patterns: dict, existing_rules: list) -> list:
    """Generate new cosmetic filter rules from discovered patterns."""
    existing_selectors = {r.get("selector") for r in existing_rules}
    new_rules = list(existing_rules)

    # Add new YTP classes
    for cls in new_patterns.get("ytp_classes", []):
        selector = f".{cls}"
        if selector not in existing_selectors:
            new_rules.append({
                "id": f"auto-{cls}",
                "selector": selector,
                "description": f"Auto-discovered: {cls}",
                "discovered": datetime.now(timezone.utc).isoformat()
            })

    # Add new renderers
    for renderer in new_patterns.get("renderers", []):
        selector = renderer
        if selector not in existing_selectors:
            new_rules.append({
                "id": f"auto-{renderer}",
                "selector": selector,
                "description": f"Auto-discovered renderer: {renderer}",
                "discovered": datetime.now(timezone.utc).isoformat()
            })

    # Add enforcement patterns
    for pattern in new_patterns.get("enforcement", []):
        selector = f"[class*='{pattern}']"
        if selector not in existing_selectors:
            new_rules.append({
                "id": f"auto-enforce-{pattern}",
                "selector": selector,
                "description": f"Auto-discovered enforcement: {pattern}",
                "discovered": datetime.now(timezone.utc).isoformat()
            })

    return new_rules


def generate_network_rules(new_patterns: dict, existing_rules: list) -> list:
    """Generate new network filter rules from discovered URL patterns."""
    existing_patterns = {r.get("pattern") for r in existing_rules}
    new_rules = list(existing_rules)

    for url_pattern in new_patterns.get("url_patterns", []):
        pattern = f"||youtube.com{url_pattern}" if url_pattern.startswith("/") else url_pattern
        if pattern not in existing_patterns:
            new_rules.append({
                "id": f"auto-net-{compute_hash(pattern)}",
                "pattern": pattern,
                "description": f"Auto-discovered: {url_pattern}",
                "discovered": datetime.now(timezone.utc).isoformat()
            })

    return new_rules


def generate_filter_update(cosmetic_rules: list, network_rules: list, script_rules: list, version: str) -> dict:
    """Generate a complete filter update payload."""
    return {
        "version": version,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "generated_by": "adablock-analyzer",
        "cosmetic": {
            "name": "YouTube Cosmetic Filters",
            "version": version,
            "updated": datetime.now(timezone.utc).isoformat(),
            "rules": cosmetic_rules
        },
        "network": {
            "name": "YouTube Network Filters",
            "version": version,
            "updated": datetime.now(timezone.utc).isoformat(),
            "rules": network_rules
        },
        "scripts": {
            "name": "YouTube Script Injection Rules",
            "version": version,
            "updated": datetime.now(timezone.utc).isoformat(),
            "rules": script_rules
        }
    }


def analyze():
    """Main analysis pipeline."""
    ensure_dirs()
    config = load_config()

    print("[AdaBlock Analyzer] Starting analysis...")
    print(f"  Endpoints: {len(config['youtube_endpoints'])}")

    # Load cached data
    cache = load_cached_scripts()
    all_new_patterns = {
        "css_classes": set(),
        "element_ids": set(),
        "functions": set(),
        "url_patterns": set(),
        "ytp_classes": set(),
        "renderers": set(),
        "enforcement": set(),
    }

    changed_scripts = 0

    for endpoint in config["youtube_endpoints"]:
        print(f"\n  Fetching: {endpoint}")
        try:
            html = fetch_page(endpoint)
        except Exception as e:
            print(f"    Error: {e}")
            continue

        # Extract inline script patterns
        soup = BeautifulSoup(html, "html.parser")
        for script in soup.find_all("script"):
            if script.string:
                patterns = extract_ad_patterns(script.string)
                for k, v in patterns.items():
                    all_new_patterns[k].update(v)

        # Fetch external scripts
        script_urls = extract_script_urls(html)
        print(f"    Found {len(script_urls)} external scripts")

        # Filter to likely ad-related scripts
        relevant_urls = [u for u in script_urls if any(
            kw in u for kw in ["player", "desktop_polymer", "base.js", "www-player"]
        )]
        print(f"    {len(relevant_urls)} relevant scripts")

        scripts = fetch_scripts(relevant_urls)
        for url, content in scripts.items():
            content_hash = compute_hash(content)
            cached_hash = cache.get(url, {}).get("hash")

            if content_hash != cached_hash:
                changed_scripts += 1
                print(f"    CHANGED: {url[:80]}...")

                patterns = extract_ad_patterns(content)
                for k, v in patterns.items():
                    all_new_patterns[k].update(v)

                # Update cache
                cache[url] = {
                    "hash": content_hash,
                    "last_seen": datetime.now(timezone.utc).isoformat(),
                    "size": len(content)
                }

    save_cached_scripts(cache)

    # Convert sets to lists
    new_patterns = {k: sorted(v) for k, v in all_new_patterns.items()}

    # Load old patterns for diff
    old_patterns_file = CACHE_DIR / "patterns_cache.json"
    old_patterns = {}
    if old_patterns_file.exists():
        with open(old_patterns_file) as f:
            old_patterns = json.load(f)

    diff = diff_patterns(old_patterns, new_patterns)

    # Save new patterns
    with open(old_patterns_file, "w") as f:
        json.dump(new_patterns, f, indent=2)

    print(f"\n  Scripts changed: {changed_scripts}")
    print(f"  New patterns found: {sum(len(v) for v in diff.values())}")
    for k, v in diff.items():
        if v:
            print(f"    {k}: {len(v)} new ({', '.join(v[:5])}{'...' if len(v) > 5 else ''})")

    # Generate updated filters
    current_filters = load_current_filters()
    cosmetic = current_filters.get("youtube-cosmetic.json", {})
    network = current_filters.get("youtube-network.json", {})
    scripts = current_filters.get("youtube-scripts.json", {})

    new_cosmetic = generate_cosmetic_rules(diff, cosmetic.get("rules", []))
    new_network = generate_network_rules(diff, network.get("rules", []))
    script_rules = scripts.get("rules", [])

    # Bump version
    old_version = cosmetic.get("version", "1.0.0")
    parts = old_version.split(".")
    new_version = f"{parts[0]}.{parts[1]}.{int(parts[2]) + 1}"

    update = generate_filter_update(new_cosmetic, new_network, script_rules, new_version)

    # Save output
    output_file = OUTPUT_DIR / f"filter-update-{new_version}.json"
    with open(output_file, "w") as f:
        json.dump(update, f, indent=2)

    print(f"\n  Filter update saved: {output_file}")
    print(f"  Version: {new_version}")
    print(f"  Cosmetic rules: {len(new_cosmetic)}")
    print(f"  Network rules: {len(new_network)}")
    print(f"  Script rules: {len(script_rules)}")

    return update


if __name__ == "__main__":
    update = analyze()
    print("\n[AdaBlock Analyzer] Done.")
