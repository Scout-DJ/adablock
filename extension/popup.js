document.addEventListener('DOMContentLoaded', async () => {
  const toggle = document.getElementById('toggle');
  const adsBlocked = document.getElementById('ads-blocked');
  const popupsDismissed = document.getElementById('popups-dismissed');
  const filterCount = document.getElementById('filter-count');
  const version = document.getElementById('version');
  const lastUpdate = document.getElementById('last-update');
  const breakdown = document.getElementById('breakdown');
  const nostrStatus = document.getElementById('nostr-status');

  async function loadStatus() {
    try {
      const status = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
      if (!status) return;

      toggle.textContent = status.enabled ? 'ON' : 'OFF';
      toggle.className = 'toggle-btn ' + (status.enabled ? 'enabled' : 'disabled');

      adsBlocked.textContent = status.stats?.adsBlocked || 0;
      popupsDismissed.textContent = status.stats?.popupsDismissed || 0;
      filterCount.textContent = status.filterCount || 0;
      version.textContent = status.version || '—';

      if (status.lastUpdate) {
        const ago = timeAgo(status.lastUpdate);
        lastUpdate.textContent = ago;
      }

      if (status.breakdown) {
        breakdown.textContent = `${status.breakdown.cosmetic}C / ${status.breakdown.network}N / ${status.breakdown.scripts}S`;
      }

      // Check Nostr connection from storage
      const data = await chrome.storage.local.get('nostr_connected');
      if (data.nostr_connected) {
        nostrStatus.textContent = '● Nostr: connected';
        nostrStatus.className = 'nostr-status connected';
      } else {
        nostrStatus.textContent = '● Nostr: offline (cached filters)';
        nostrStatus.className = 'nostr-status disconnected';
      }
    } catch (e) {
      console.error('Failed to load status:', e);
    }
  }

  toggle.addEventListener('click', async () => {
    try {
      const result = await chrome.runtime.sendMessage({ type: 'TOGGLE_ENABLED' });
      toggle.textContent = result.enabled ? 'ON' : 'OFF';
      toggle.className = 'toggle-btn ' + (result.enabled ? 'enabled' : 'disabled');
    } catch (e) {}
  });

  function timeAgo(ts) {
    const diff = Date.now() - ts;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  loadStatus();
});
