/**
 * AdaBlock — Background Service Worker
 * Manages filter rules, Nostr subscription, and extension state.
 */

const STORAGE_KEYS = {
  FILTERS_COSMETIC: 'filters_cosmetic',
  FILTERS_NETWORK: 'filters_network',
  FILTERS_SCRIPTS: 'filters_scripts',
  LAST_UPDATE: 'last_update',
  FILTER_VERSION: 'filter_version',
  STATS: 'stats',
  ENABLED: 'enabled',
  NOSTR_FILTERS: 'nostr_filters'
};

const DEFAULT_STATS = {
  adsBlocked: 0,
  popupsDismissed: 0,
  filtersApplied: 0,
  lastAdDetected: null
};

// Initialize on install
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install' || details.reason === 'update') {
    await initializeFilters();
    console.log('[AdaBlock] Extension installed/updated, seed filters loaded');
  }
});

// Always ensure filters on service worker load (covers dev mode reloads)
ensureFiltersLoaded().then(() => console.log('[AdaBlock] Filters verified on load'));

// Initialize on startup
chrome.runtime.onStartup.addListener(async () => {
  console.log('[AdaBlock] Service worker started');
  await ensureFiltersLoaded();
});

/**
 * Load seed filters from bundled JSON files
 */
async function initializeFilters() {
  try {
    const [cosmeticResp, networkResp, scriptsResp] = await Promise.all([
      fetch(chrome.runtime.getURL('filters/youtube-cosmetic.json')),
      fetch(chrome.runtime.getURL('filters/youtube-network.json')),
      fetch(chrome.runtime.getURL('filters/youtube-scripts.json'))
    ]);

    const cosmetic = await cosmeticResp.json();
    const network = await networkResp.json();
    const scripts = await scriptsResp.json();

    await chrome.storage.local.set({
      [STORAGE_KEYS.FILTERS_COSMETIC]: cosmetic,
      [STORAGE_KEYS.FILTERS_NETWORK]: network,
      [STORAGE_KEYS.FILTERS_SCRIPTS]: scripts,
      [STORAGE_KEYS.LAST_UPDATE]: Date.now(),
      [STORAGE_KEYS.FILTER_VERSION]: '1.0.0',
      [STORAGE_KEYS.STATS]: DEFAULT_STATS,
      [STORAGE_KEYS.ENABLED]: true
    });

    console.log('[AdaBlock] Seed filters loaded:', {
      cosmetic: cosmetic.rules?.length || 0,
      network: network.rules?.length || 0,
      scripts: scripts.rules?.length || 0
    });
  } catch (err) {
    console.error('[AdaBlock] Failed to load seed filters:', err);
  }
}

/**
 * Ensure filters are loaded (idempotent)
 */
async function ensureFiltersLoaded() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.FILTERS_COSMETIC);
  if (!data[STORAGE_KEYS.FILTERS_COSMETIC]) {
    await initializeFilters();
  }
}

/**
 * Handle messages from content script and popup
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse);
  return true; // async response
});

async function handleMessage(message, sender) {
  switch (message.type) {
    case 'GET_FILTERS':
      return getFilters();

    case 'GET_STATUS':
      return getStatus();

    case 'AD_DETECTED':
      return recordAdDetection(message.data);

    case 'POPUP_DISMISSED':
      return recordPopupDismissal();

    case 'TOGGLE_ENABLED':
      return toggleEnabled();

    case 'REPORT_PATTERN':
      return recordNewPattern(message.data);

    case 'APPLY_NOSTR_UPDATE':
      return applyNostrUpdate(message.data);

    default:
      return { error: 'Unknown message type' };
  }
}

async function getFilters() {
  await ensureFiltersLoaded();
  const data = await chrome.storage.local.get([
    STORAGE_KEYS.FILTERS_COSMETIC,
    STORAGE_KEYS.FILTERS_NETWORK,
    STORAGE_KEYS.FILTERS_SCRIPTS,
    STORAGE_KEYS.ENABLED
  ]);
  return {
    cosmetic: data[STORAGE_KEYS.FILTERS_COSMETIC] || { rules: [] },
    network: data[STORAGE_KEYS.FILTERS_NETWORK] || { rules: [] },
    scripts: data[STORAGE_KEYS.FILTERS_SCRIPTS] || { rules: [] },
    enabled: data[STORAGE_KEYS.ENABLED] !== false
  };
}

async function getStatus() {
  await ensureFiltersLoaded();
  const data = await chrome.storage.local.get([
    STORAGE_KEYS.LAST_UPDATE,
    STORAGE_KEYS.FILTER_VERSION,
    STORAGE_KEYS.STATS,
    STORAGE_KEYS.ENABLED,
    STORAGE_KEYS.FILTERS_COSMETIC,
    STORAGE_KEYS.FILTERS_NETWORK,
    STORAGE_KEYS.FILTERS_SCRIPTS
  ]);

  const cosmeticCount = data[STORAGE_KEYS.FILTERS_COSMETIC]?.rules?.length || 0;
  const networkCount = data[STORAGE_KEYS.FILTERS_NETWORK]?.rules?.length || 0;
  const scriptCount = data[STORAGE_KEYS.FILTERS_SCRIPTS]?.rules?.length || 0;

  return {
    enabled: data[STORAGE_KEYS.ENABLED] !== false,
    lastUpdate: data[STORAGE_KEYS.LAST_UPDATE] || null,
    version: data[STORAGE_KEYS.FILTER_VERSION] || '0.0.0',
    stats: data[STORAGE_KEYS.STATS] || DEFAULT_STATS,
    filterCount: cosmeticCount + networkCount + scriptCount,
    breakdown: { cosmetic: cosmeticCount, network: networkCount, scripts: scriptCount }
  };
}

async function recordAdDetection(data) {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.STATS);
  const stats = stored[STORAGE_KEYS.STATS] || { ...DEFAULT_STATS };
  stats.adsBlocked++;
  stats.lastAdDetected = Date.now();
  await chrome.storage.local.set({ [STORAGE_KEYS.STATS]: stats });
  return { ok: true };
}

async function recordPopupDismissal() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.STATS);
  const stats = stored[STORAGE_KEYS.STATS] || { ...DEFAULT_STATS };
  stats.popupsDismissed++;
  await chrome.storage.local.set({ [STORAGE_KEYS.STATS]: stats });
  return { ok: true };
}

async function toggleEnabled() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.ENABLED);
  const newState = !(stored[STORAGE_KEYS.ENABLED] !== false);
  await chrome.storage.local.set({ [STORAGE_KEYS.ENABLED]: newState });
  return { enabled: newState };
}

async function recordNewPattern(data) {
  // Store newly discovered ad patterns for the agent to analyze
  const stored = await chrome.storage.local.get('discovered_patterns');
  const patterns = stored.discovered_patterns || [];
  patterns.push({
    ...data,
    timestamp: Date.now(),
    url: data.url || 'unknown'
  });
  // Keep last 100 patterns
  if (patterns.length > 100) patterns.splice(0, patterns.length - 100);
  await chrome.storage.local.set({ discovered_patterns: patterns });
  return { ok: true };
}

async function applyNostrUpdate(filterData) {
  try {
    if (filterData.cosmetic) {
      await chrome.storage.local.set({ [STORAGE_KEYS.FILTERS_COSMETIC]: filterData.cosmetic });
    }
    if (filterData.network) {
      await chrome.storage.local.set({ [STORAGE_KEYS.FILTERS_NETWORK]: filterData.network });
    }
    if (filterData.scripts) {
      await chrome.storage.local.set({ [STORAGE_KEYS.FILTERS_SCRIPTS]: filterData.scripts });
    }
    await chrome.storage.local.set({
      [STORAGE_KEYS.LAST_UPDATE]: Date.now(),
      [STORAGE_KEYS.FILTER_VERSION]: filterData.version || 'nostr-update'
    });

    // Notify all YouTube tabs to reload filters
    const tabs = await chrome.tabs.query({ url: '*://*.youtube.com/*' });
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, { type: 'FILTERS_UPDATED' }).catch(() => {});
    }

    console.log('[AdaBlock] Applied Nostr filter update');
    return { ok: true };
  } catch (err) {
    console.error('[AdaBlock] Failed to apply Nostr update:', err);
    return { error: err.message };
  }
}

// Periodic check for Nostr updates (every 30 minutes)
chrome.alarms.create('nostr-check', { periodInMinutes: 30 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'nostr-check') {
    // The nostr.js module handles the actual subscription
    // This alarm just ensures we reconnect if disconnected
    console.log('[AdaBlock] Periodic Nostr check triggered');
  }
});
