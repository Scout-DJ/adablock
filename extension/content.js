/**
 * AdaBlock — Content Script
 * Injected into YouTube pages. Detects and removes ads, dismisses anti-adblock popups,
 * skips video ad segments, and applies cosmetic filters.
 */

(function() {
  'use strict';

  const LOG_PREFIX = '[AdaBlock]';
  let filters = null;
  let enabled = true;
  let observer = null;
  let videoObserver = null;
  let styleElement = null;

  // ========================================
  // Initialization
  // ========================================

  async function init() {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_FILTERS' });
      if (response) {
        filters = response;
        enabled = response.enabled !== false;
      }
    } catch (e) {
      // Extension context may be invalidated; use fallback filters
      filters = getFallbackFilters();
    }

    if (!enabled) return;

    injectCosmeticStyles();
    startMutationObserver();
    startVideoAdDetector();
    startAntiAdblockDetector();

    // Listen for filter updates from background
    try {
      chrome.runtime.onMessage.addListener((msg) => {
        if (msg.type === 'FILTERS_UPDATED') {
          reloadFilters();
        }
      });
    } catch (e) {}

    log('Initialized');
  }

  // ========================================
  // Cosmetic Filtering (CSS-based hiding)
  // ========================================

  function injectCosmeticStyles() {
    if (styleElement) styleElement.remove();
    styleElement = document.createElement('style');
    styleElement.id = 'adablock-cosmetic';

    const selectors = getCosmeticSelectors();
    if (selectors.length > 0) {
      styleElement.textContent = selectors.join(',\n') + ' { display: none !important; }';
    }

    (document.head || document.documentElement).appendChild(styleElement);
  }

  function getCosmeticSelectors() {
    const selectors = [];

    // From loaded filters
    if (filters?.cosmetic?.rules) {
      for (const rule of filters.cosmetic.rules) {
        if (rule.selector) selectors.push(rule.selector);
      }
    }

    // Hardcoded essential selectors (always present as fallback)
    const essential = [
      // Ad overlays
      '.ytp-ad-overlay-container',
      '.ytp-ad-overlay-slot',
      '.ytp-ad-text-overlay',
      '.ytp-ad-overlay-close-button',
      '.ytp-ad-overlay-ad-info-button-container',
      // Pre-roll / mid-roll ad UI
      '.ytp-ad-skip-button-container',
      '.ytp-ad-preview-container',
      '.ytp-ad-message-container',
      '.ytp-ad-player-overlay',
      '.ytp-ad-player-overlay-instream-info',
      '.ytp-ad-action-interstitial',
      '.ytp-ad-action-interstitial-background-container',
      '.ytp-ad-image-overlay',
      // Companion ads / sidebar ads
      '#player-ads',
      '#masthead-ad',
      '#ad-slot-rail',
      'ytd-ad-slot-renderer',
      'ytd-banner-promo-renderer',
      'ytd-statement-banner-renderer',
      'ytd-in-feed-ad-layout-renderer',
      'ytd-promoted-sparkles-web-renderer',
      'ytd-promoted-video-renderer',
      'ytd-display-ad-renderer',
      'ytd-compact-promoted-video-renderer',
      'ytd-action-companion-ad-renderer',
      'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-ads"]',
      // Promoted content in feed
      'ytd-promoted-sparkles-text-search-renderer',
      'ytd-search-pyv-renderer',
      '#search-pva',
      // Ad badges
      '.ytd-badge-supported-renderer[aria-label="Ad"]',
      'span.ytd-badge-supported-renderer:has-text("Ad")',
      // Anti-adblock popup
      'tp-yt-paper-dialog:has(#dismiss-button)',
      'ytd-enforcement-message-view-model',
      'ytd-popup-container:has(.ytd-enforcement-message-view-model)',
      '#dialog:has(yt-ad-blocker-warning)',
      // Merch shelf
      'ytd-merch-shelf-renderer',
      // Movie offers
      'ytd-movie-offer-module-renderer'
    ];

    for (const sel of essential) {
      if (!selectors.includes(sel)) selectors.push(sel);
    }

    return selectors;
  }

  // ========================================
  // DOM Mutation Observer
  // ========================================

  function startMutationObserver() {
    if (observer) observer.disconnect();

    observer = new MutationObserver((mutations) => {
      if (!enabled) return;
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          processNewElement(node);
        }
      }
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  function processNewElement(el) {
    // Check for anti-adblock popup
    if (isAntiAdblockPopup(el)) {
      dismissAntiAdblockPopup(el);
      return;
    }

    // Check for ad containers and remove/hide
    if (isAdElement(el)) {
      hideElement(el);
      notifyAdDetected(el);
    }

    // Check children too
    const adChildren = el.querySelectorAll?.(getCosmeticSelectors().join(','));
    if (adChildren) {
      adChildren.forEach(child => {
        hideElement(child);
        notifyAdDetected(child);
      });
    }
  }

  function isAdElement(el) {
    const tag = el.tagName?.toLowerCase() || '';
    const cls = el.className || '';
    const id = el.id || '';

    // Known ad renderers
    if (tag.startsWith('ytd-') && (
      tag.includes('-ad-') ||
      tag.includes('-promoted-') ||
      tag === 'ytd-banner-promo-renderer' ||
      tag === 'ytd-statement-banner-renderer'
    )) return true;

    // YTP ad classes
    if (typeof cls === 'string' && cls.includes('ytp-ad-')) return true;

    // Ad slot IDs
    if (['player-ads', 'masthead-ad', 'ad-slot-rail', 'search-pva'].includes(id)) return true;

    return false;
  }

  function hideElement(el) {
    if (el && el.style) {
      el.style.setProperty('display', 'none', 'important');
      el.setAttribute('data-adablock-hidden', 'true');
    }
  }

  // ========================================
  // Video Ad Detection & Skipping
  // ========================================

  function startVideoAdDetector() {
    // Poll for video ads (more reliable than mutation observer for video state)
    setInterval(checkForVideoAd, 500);
  }

  function checkForVideoAd() {
    if (!enabled) return;

    const player = document.querySelector('.html5-video-player');
    if (!player) return;

    const video = player.querySelector('video');
    if (!video) return;

    // Check if an ad is playing
    const isAd = player.classList.contains('ad-showing') ||
                 player.classList.contains('ad-interrupting') ||
                 document.querySelector('.ytp-ad-player-overlay') !== null ||
                 document.querySelector('.ytp-ad-preview-container') !== null;

    if (isAd) {
      skipVideoAd(video, player);
    }
  }

  function skipVideoAd(video, player) {
    // Strategy 1: Click skip button if available
    const skipButton = document.querySelector('.ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button, [id^="skip-button"]');
    if (skipButton) {
      skipButton.click();
      log('Clicked skip button');
      notifyAdDetected({ type: 'video-skip-button' });
      return;
    }

    // Strategy 2: Skip to end of ad video
    if (video.duration && isFinite(video.duration) && video.duration > 0) {
      video.currentTime = video.duration;
      log('Skipped to end of ad video');
      notifyAdDetected({ type: 'video-skip-time' });
      return;
    }

    // Strategy 3: Mute ad and speed it up
    if (video.volume > 0 || !video.muted) {
      video.muted = true;
      video.playbackRate = 16; // Speed through it
      log('Muted and sped up ad');
    }

    // Strategy 4: Hide ad overlay elements
    const overlays = player.querySelectorAll('.ytp-ad-overlay-container, .ytp-ad-message-container');
    overlays.forEach(o => hideElement(o));
  }

  // ========================================
  // Anti-Adblock Popup Detection & Dismissal
  // ========================================

  function startAntiAdblockDetector() {
    setInterval(checkForAntiAdblockPopup, 1000);
  }

  function checkForAntiAdblockPopup() {
    if (!enabled) return;

    // YouTube's "Ad blockers are not allowed" dialog selectors
    const popupSelectors = [
      'tp-yt-paper-dialog:has(yt-formatted-string[is-empty])',
      'ytd-enforcement-message-view-model',
      'ytd-popup-container .ytd-enforcement-message-view-model',
      '#dialog:has([class*="ad-blocker"])',
      'tp-yt-paper-dialog.ytd-popup-container',
      'yt-playability-error-supported-renderers:has([class*="enforcement"])'
    ];

    for (const selector of popupSelectors) {
      try {
        const popup = document.querySelector(selector);
        if (popup && isVisible(popup)) {
          if (isAntiAdblockContent(popup)) {
            dismissAntiAdblockPopup(popup);
          }
        }
      } catch (e) {
        // :has() may not be supported in all contexts
      }
    }

    // Also look for the popup by text content
    const dialogs = document.querySelectorAll('tp-yt-paper-dialog, ytd-popup-container > *');
    for (const dialog of dialogs) {
      if (isVisible(dialog) && isAntiAdblockContent(dialog)) {
        dismissAntiAdblockPopup(dialog);
      }
    }
  }

  function isAntiAdblockPopup(el) {
    if (!el || !el.textContent) return false;
    return isAntiAdblockContent(el);
  }

  function isAntiAdblockContent(el) {
    const text = (el.textContent || '').toLowerCase();
    const keywords = [
      'ad blockers are not allowed',
      'ad blockers violate',
      'allow youtube ads',
      'ad blocker',
      'ad blocking',
      'adblock detected',
      'please disable your ad blocker',
      'adblocker',
      'youtube doesn\'t allow ad blockers'
    ];
    return keywords.some(kw => text.includes(kw));
  }

  function dismissAntiAdblockPopup(popup) {
    log('Anti-adblock popup detected, dismissing');

    // Try clicking dismiss/close buttons
    const dismissSelectors = [
      '#dismiss-button',
      '.dismiss-button',
      '[aria-label="Close"]',
      '[aria-label="Dismiss"]',
      'yt-button-renderer#dismiss-button',
      '.yt-spec-button-shape-next--call-to-action',
      'tp-yt-paper-dialog #dismiss-button'
    ];

    for (const sel of dismissSelectors) {
      const btn = popup.querySelector(sel) || document.querySelector(sel);
      if (btn) {
        btn.click();
        log('Clicked dismiss button');
        break;
      }
    }

    // Hide the popup itself
    hideElement(popup);

    // Remove any overlay/backdrop
    const backdrops = document.querySelectorAll('tp-yt-iron-overlay-backdrop, .tp-yt-iron-overlay-backdrop');
    backdrops.forEach(b => {
      b.style.setProperty('display', 'none', 'important');
      b.remove();
    });

    // Re-enable scrolling
    document.body.style.overflow = '';
    document.documentElement.style.overflow = '';

    // Resume video if paused
    const video = document.querySelector('video');
    if (video && video.paused) {
      video.play().catch(() => {});
    }

    notifyPopupDismissed();
  }

  // ========================================
  // Script Injection (from filter rules)
  // ========================================

  function executeScriptRules() {
    if (!filters?.scripts?.rules) return;

    for (const rule of filters.scripts.rules) {
      if (rule.code && rule.enabled !== false) {
        try {
          const fn = new Function(rule.code);
          fn();
          log(`Executed script rule: ${rule.name || 'unnamed'}`);
        } catch (e) {
          console.warn(`${LOG_PREFIX} Script rule failed:`, rule.name, e);
        }
      }
    }
  }

  // Run script rules when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', executeScriptRules);
  } else {
    executeScriptRules();
  }

  // ========================================
  // Communication with Background Script
  // ========================================

  function notifyAdDetected(data) {
    try {
      chrome.runtime.sendMessage({
        type: 'AD_DETECTED',
        data: {
          url: window.location.href,
          element: data?.tagName || data?.type || 'unknown',
          timestamp: Date.now()
        }
      }).catch(() => {});
    } catch (e) {}
  }

  function notifyPopupDismissed() {
    try {
      chrome.runtime.sendMessage({ type: 'POPUP_DISMISSED' }).catch(() => {});
    } catch (e) {}
  }

  function reportNewPattern(pattern) {
    try {
      chrome.runtime.sendMessage({
        type: 'REPORT_PATTERN',
        data: pattern
      }).catch(() => {});
    } catch (e) {}
  }

  async function reloadFilters() {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_FILTERS' });
      if (response) {
        filters = response;
        enabled = response.enabled !== false;
        injectCosmeticStyles();
        executeScriptRules();
        log('Filters reloaded');
      }
    } catch (e) {}
  }

  // ========================================
  // Pattern Discovery
  // ========================================

  function discoverNewAdPatterns() {
    // Look for elements that look like ads but aren't in our filter list
    const suspicious = document.querySelectorAll('[class*="ad-"], [class*="promo"], [id*="ad-"], [id*="sponsor"]');
    const knownSelectors = new Set(getCosmeticSelectors());

    for (const el of suspicious) {
      if (el.getAttribute('data-adablock-hidden')) continue;
      if (!isVisible(el)) continue;

      const selector = generateSelector(el);
      if (!knownSelectors.has(selector)) {
        reportNewPattern({
          selector,
          tagName: el.tagName,
          className: el.className,
          id: el.id,
          textContent: (el.textContent || '').substring(0, 100),
          url: window.location.href
        });
      }
    }
  }

  // Run pattern discovery periodically
  setInterval(discoverNewAdPatterns, 30000);

  // ========================================
  // Utilities
  // ========================================

  function isVisible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  }

  function generateSelector(el) {
    if (el.id) return `#${el.id}`;
    if (el.tagName) {
      const tag = el.tagName.toLowerCase();
      if (el.className && typeof el.className === 'string') {
        const cls = el.className.split(/\s+/).filter(c => c).slice(0, 2).join('.');
        return `${tag}.${cls}`;
      }
      return tag;
    }
    return '';
  }

  function getFallbackFilters() {
    return {
      cosmetic: { rules: [] },
      network: { rules: [] },
      scripts: { rules: [] },
      enabled: true
    };
  }

  function log(...args) {
    console.log(LOG_PREFIX, ...args);
  }

  // ========================================
  // Start
  // ========================================

  init();

})();
