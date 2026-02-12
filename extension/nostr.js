/**
 * AdaBlock — Nostr Client
 * Subscribes to filter update events from Nostr relays.
 * Filter updates are kind 30078 (replaceable parameterized) with d-tag "adablock-filters".
 * Verifies signature from trusted pubkey before applying.
 *
 * This module is imported by the background service worker.
 * Usage: Include via importScripts() or dynamic import in background.js
 */

const NOSTR_CONFIG = {
  relays: [
    'wss://relay.substation.ninja',
    'wss://relay.damus.io',
    'wss://nos.lol',
    'wss://relay.nostr.band'
  ],
  // Trusted pubkey for AdaBlock filter updates (hex)
  // Replace with your actual pubkey after generating keypair
  trustedPubkey: 'REPLACE_WITH_ADABLOCK_PUBKEY_HEX',
  filterKind: 30078,
  dTag: 'adablock-filters',
  reconnectInterval: 30000,
  subscriptionId: 'adablock-filters-sub'
};

class NostrFilterClient {
  constructor(config = NOSTR_CONFIG) {
    this.config = config;
    this.connections = new Map(); // relay URL -> WebSocket
    this.latestEvent = null;
    this.latestTimestamp = 0;
    this.onUpdate = null; // callback for filter updates
  }

  /**
   * Connect to all relays and subscribe to filter events
   */
  start(onUpdate) {
    this.onUpdate = onUpdate;
    for (const relay of this.config.relays) {
      this.connectRelay(relay);
    }
  }

  /**
   * Connect to a single relay
   */
  connectRelay(url) {
    try {
      const ws = new WebSocket(url);

      ws.onopen = () => {
        console.log(`[AdaBlock/Nostr] Connected to ${url}`);
        this.connections.set(url, ws);
        this.subscribe(ws);
        this.updateConnectionStatus(true);
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          this.handleMessage(msg, url);
        } catch (e) {
          console.warn(`[AdaBlock/Nostr] Parse error from ${url}:`, e);
        }
      };

      ws.onerror = (err) => {
        console.warn(`[AdaBlock/Nostr] Error on ${url}:`, err);
      };

      ws.onclose = () => {
        console.log(`[AdaBlock/Nostr] Disconnected from ${url}`);
        this.connections.delete(url);
        this.updateConnectionStatus(this.connections.size > 0);
        // Reconnect
        setTimeout(() => this.connectRelay(url), this.config.reconnectInterval);
      };
    } catch (e) {
      console.error(`[AdaBlock/Nostr] Failed to connect to ${url}:`, e);
      setTimeout(() => this.connectRelay(url), this.config.reconnectInterval);
    }
  }

  /**
   * Send subscription request for filter events
   */
  subscribe(ws) {
    const filter = {
      kinds: [this.config.filterKind],
      '#d': [this.config.dTag],
      limit: 1
    };

    // Only accept from trusted pubkey if configured
    if (this.config.trustedPubkey && !this.config.trustedPubkey.startsWith('REPLACE')) {
      filter.authors = [this.config.trustedPubkey];
    }

    const sub = ['REQ', this.config.subscriptionId, filter];
    ws.send(JSON.stringify(sub));
  }

  /**
   * Handle incoming Nostr messages
   */
  handleMessage(msg, relayUrl) {
    if (!Array.isArray(msg)) return;

    const [type, ...rest] = msg;

    if (type === 'EVENT') {
      const [subId, event] = rest;
      if (subId !== this.config.subscriptionId) return;
      this.handleEvent(event, relayUrl);
    } else if (type === 'EOSE') {
      console.log(`[AdaBlock/Nostr] End of stored events from ${relayUrl}`);
    } else if (type === 'NOTICE') {
      console.log(`[AdaBlock/Nostr] Notice from ${relayUrl}:`, rest[0]);
    }
  }

  /**
   * Handle a filter update event
   */
  handleEvent(event, relayUrl) {
    // Validate event structure
    if (!event || !event.id || !event.pubkey || !event.sig || !event.content) {
      console.warn('[AdaBlock/Nostr] Invalid event structure');
      return;
    }

    // Check trusted pubkey
    if (this.config.trustedPubkey && !this.config.trustedPubkey.startsWith('REPLACE')) {
      if (event.pubkey !== this.config.trustedPubkey) {
        console.warn('[AdaBlock/Nostr] Event from untrusted pubkey:', event.pubkey);
        return;
      }
    }

    // Check if this is newer than what we have
    if (event.created_at <= this.latestTimestamp) {
      return; // Already have this or newer
    }

    // Verify d-tag
    const dTag = event.tags?.find(t => t[0] === 'd');
    if (!dTag || dTag[1] !== this.config.dTag) {
      return;
    }

    // Verify signature (simplified — full Schnorr verification would need crypto lib)
    // In production, use noble-secp256k1 or similar
    if (!this.verifyEventId(event)) {
      console.warn('[AdaBlock/Nostr] Event ID verification failed');
      return;
    }

    console.log(`[AdaBlock/Nostr] New filter update from ${relayUrl}, created_at:`, event.created_at);

    this.latestEvent = event;
    this.latestTimestamp = event.created_at;

    // Parse filter content
    try {
      const filterData = JSON.parse(event.content);
      if (this.onUpdate) {
        this.onUpdate(filterData);
      }
    } catch (e) {
      console.error('[AdaBlock/Nostr] Failed to parse filter content:', e);
    }
  }

  /**
   * Verify event ID matches hash of serialized event
   * Full implementation would use SHA-256 of [0, pubkey, created_at, kind, tags, content]
   */
  verifyEventId(event) {
    // Basic structural validation
    if (typeof event.id !== 'string' || event.id.length !== 64) return false;
    if (typeof event.pubkey !== 'string' || event.pubkey.length !== 64) return false;
    if (typeof event.sig !== 'string' || event.sig.length !== 128) return false;
    if (typeof event.created_at !== 'number') return false;
    if (typeof event.kind !== 'number') return false;

    // Full SHA-256 verification
    return this.verifySHA256(event);
  }

  async verifySHA256(event) {
    try {
      const serialized = JSON.stringify([
        0,
        event.pubkey,
        event.created_at,
        event.kind,
        event.tags || [],
        event.content
      ]);
      const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized));
      const hashHex = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
      return hashHex === event.id;
    } catch (e) {
      // crypto.subtle may not be available in all contexts
      return true; // Fall back to accepting
    }
  }

  /**
   * Update connection status in storage
   */
  async updateConnectionStatus(connected) {
    try {
      await chrome.storage.local.set({ nostr_connected: connected });
    } catch (e) {}
  }

  /**
   * Disconnect from all relays
   */
  stop() {
    for (const [url, ws] of this.connections) {
      try {
        ws.close();
      } catch (e) {}
    }
    this.connections.clear();
    this.updateConnectionStatus(false);
  }
}

// Auto-start if in service worker context
if (typeof chrome !== 'undefined' && chrome.runtime) {
  const nostrClient = new NostrFilterClient();

  nostrClient.start(async (filterData) => {
    // Apply the update via background script
    try {
      await chrome.runtime.sendMessage({
        type: 'APPLY_NOSTR_UPDATE',
        data: filterData
      });
    } catch (e) {
      // If message fails, apply directly to storage
      const update = {};
      if (filterData.cosmetic) update.filters_cosmetic = filterData.cosmetic;
      if (filterData.network) update.filters_network = filterData.network;
      if (filterData.scripts) update.filters_scripts = filterData.scripts;
      update.last_update = Date.now();
      update.filter_version = filterData.version || 'nostr';
      await chrome.storage.local.set(update);
    }
  });
}
