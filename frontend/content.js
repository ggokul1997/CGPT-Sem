/* content.js — Semantic Subtitle Translator (YouTube)
 * Responsibilities:
 *  - Listen for popup messages: SETTINGS_CHANGED, START_TRANSLATION, STOP_TRANSLATION
 *  - Detect YouTube player & inject overlay
 *  - Track playback (timeupdate/seek/rate/play/pause) and request JIT translations
 *  - Manage simple in-memory cache and abort inflight requests
 *  - State machine: idle → active → error (with recovery)
 *  - Log with consistent prefix; avoid noisy spam
 */

// ========================= Utilities & constants =========================
const SST = {
  PREFIX: '[SST]',
  SELECTORS: {
    playerShell: '#movie_player.html5-video-player',
    video: 'video.html5-main-video',
    watchRoot: 'ytd-watch-flexy'
  },
  MODES: { IDLE: 'idle', ACTIVE: 'active', ERROR: 'error' },
  TICK_HZ: 4,                         // timeupdate throttle target (~4 fps)
  WINDOW_SEC: 6,                      // prev/next window size total context (3s back/fwd implicit)
  CHUNK_AHEAD_SEC: 2.0,               // mild prefetch tolerance
  OVERLAY_ID: 'sst-overlay',
  LOG_LEVEL: 'info',                  // 'debug'|'info'|'warn'|'error'
  BACKEND_BASE: 'http://localhost:8000', // TODO: allow override if needed
  CACHE_TTL_MS: 2 * 60 * 1000,        // 2 minutes
  URL_CHECK_MS: 700,                  // SPA URL change watcher
};

const log = {
  debug: (...args) => (SST.LOG_LEVEL === 'debug') && console.debug(SST.PREFIX, ...args),
  info:  (...args) => console.info(SST.PREFIX, ...args),
  warn:  (...args) => console.warn(SST.PREFIX, ...args),
  error: (...args) => console.error(SST.PREFIX, ...args),
};

// ========================= Global state =========================
const state = {
  mode: SST.MODES.IDLE,
  enabled: false,
  language: 'en',
  hint: '',
  videoEl: null,
  overlayEl: null,
  lastUrl: location.href,
  videoId: null,
  tickTimer: null,
  lastTickAt: 0,
  inflight: null,              // { ctrl: AbortController, kind: 'chunks'|'stream' }
  cache: new Map(),            // key -> { ts:number, data:any }
  obs: null,                   // MutationObserver
};

// ========================= DOM discovery & overlay =========================
function getVideoIdFromUrl(href = location.href) {
  try {
    const u = new URL(href);
    // watch?v=xxx or shorts/xxx
    if (u.pathname.startsWith('/watch')) return u.searchParams.get('v');
    if (u.pathname.startsWith('/shorts/')) return u.pathname.split('/')[2] || null;
    return null;
  } catch { return null; }
}

function findPlayerShell() {
  return document.querySelector(SST.SELECTORS.playerShell);
}

function findVideoEl() {
  return document.querySelector(SST.SELECTORS.video);
}

function ensureOverlay(parent) {
  let el = document.getElementById(SST.OVERLAY_ID);
  if (el && !parent.contains(el)) {
    // If overlay exists elsewhere (after DOM reshuffle), remove & recreate
    try { el.remove(); } catch {}
    el = null;
  }
  if (!el) {
    el = document.createElement('div');
    el.id = SST.OVERLAY_ID;
    el.className = 'sst-overlay'; // styled by styles.css (content script CSS)
    el.style.position = 'absolute';
    el.style.inset = '0';
    el.style.pointerEvents = 'none';
    el.style.display = 'flex';
    el.style.alignItems = 'flex-end';
    el.style.justifyContent = 'center';
    el.style.padding = '2% 4%';
    el.style.zIndex = '3000'; // above most player chrome, below menus
    el.setAttribute('aria-live', 'polite');
    el.setAttribute('aria-atomic', 'true');

    const caption = document.createElement('div');
    caption.className = 'sst-caption';
    caption.style.maxWidth = '90%';
    caption.style.textAlign = 'center';
    caption.style.textShadow = '0 1px 2px rgba(0,0,0,0.8)';
    caption.style.fontSize = 'clamp(14px, 2.4vw, 28px)';
    caption.style.lineHeight = '1.35';
    caption.style.color = 'white';
    caption.style.fontWeight = '600';
    caption.style.background = 'rgba(0,0,0,0.35)';
    caption.style.padding = '6px 10px';
    caption.style.borderRadius = '10px';
    caption.style.backdropFilter = 'blur(0.5px)';
    caption.id = 'sst-caption';
    el.appendChild(caption);

    parent.appendChild(el);
    log.info('Overlay injected.');
  }
  return el;
}

function clearOverlay() {
  const el = document.getElementById(SST.OVERLAY_ID);
  if (el?.isConnected) try { el.remove(); } catch {}
}

function setCaptionText(text) {
  const caption = document.getElementById('sst-caption');
  if (caption) caption.textContent = text || '';
}

// ========================= Cache =========================
function cacheKey(videoId, lang, tSec) {
  const bucket = Math.floor(tSec); // 1s bucket — simple & effective
  return `${videoId}|${lang}|${bucket}`;
}
function cacheGet(key) {
  const hit = state.cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > SST.CACHE_TTL_MS) {
    state.cache.delete(key);
    return null;
  }
  return hit.data;
}
function cacheSet(key, data) {
  state.cache.set(key, { ts: Date.now(), data });
  // naive trim
  if (state.cache.size > 500) {
    const firstKey = state.cache.keys().next().value;
    state.cache.delete(firstKey);
  }
}

// ========================= Backend I/O (placeholders, robust aborts) =========================
async function fetchWindowChunks(videoId, tSec, signal) {
  // Returns [{start:number, end:number, text:string}, ...] original lines
  const u = new URL('/chunks', SST.BACKEND_BASE);
  u.searchParams.set('videoId', videoId);
  u.searchParams.set('t', String(tSec));
  u.searchParams.set('window', String(SST.WINDOW_SEC));
  log.debug('Fetching chunks', u.toString());
  const res = await fetch(u.toString(), { signal });
  if (!res.ok) throw new Error(`chunks ${res.status}`);
  return res.json();
}

async function translateWindow(lines, lang, hint, signal) {
  // Returns same shape, but with translated `text`
  const u = new URL('/translate', SST.BACKEND_BASE);
  const res = await fetch(u.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lines, target: lang, hint }),
    signal
  });
  if (!res.ok) throw new Error(`translate ${res.status}`);
  return res.json();
}

// ========================= Playback & hydration =========================
function isAdPlaying() {
  const shell = findPlayerShell();
  return !!shell?.classList?.contains('ad-showing');
}

function onTimeTick() {
  if (!state.videoEl || state.mode !== SST.MODES.ACTIVE) return;

  const now = performance.now();
  if (now - state.lastTickAt < (1000 / SST.TICK_HZ)) return;
  state.lastTickAt = now;

  const t = state.videoEl.currentTime || 0;
  const vid = state.videoId;
  if (!vid) return;

  if (isAdPlaying()) {
    setCaptionText(''); // hide during ads
    return;
  }

  const ckey = cacheKey(vid, state.language, t);
  const cached = cacheGet(ckey);
  if (cached) {
    renderFromWindow(cached, t);
    return;
  }

  // Cancel previous inflight
  if (state.inflight) {
    try { state.inflight.ctrl.abort(); } catch {}
    state.inflight = null;
  }

  const ctrl = new AbortController();
  state.inflight = { ctrl, kind: 'chunks' };

  fetchWindowChunks(vid, t, ctrl.signal)
    .then(origLines => {
      state.inflight = { ctrl, kind: 'translate' };
      return translateWindow(origLines, state.language, state.hint, ctrl.signal);
    })
    .then(translated => {
      cacheSet(ckey, translated);
      renderFromWindow(translated, t);
      state.inflight = null;
    })
    .catch(err => {
      if (err.name === 'AbortError') return;
      log.warn('Hydration error', err);
      setState(SST.MODES.ERROR);
      // brief fallback: clear caption
      setCaptionText('');
      // soft auto-recover: return to ACTIVE to allow next tick to retry
      setTimeout(() => setState(SST.MODES.ACTIVE), 1200);
    });
}

function renderFromWindow(lines, t) {
  // Pick the line that spans current time; otherwise the closest future within tolerance.
  let current = null;
  for (const ln of lines) {
    if (t >= ln.start && t < ln.end) { current = ln; break; }
  }
  if (!current) {
    // look ahead a tiny bit to avoid flicker between gaps
    current = lines.find(ln => ln.start - t <= SST.CHUNK_AHEAD_SEC && ln.start > t) || null;
  }
  setCaptionText(current ? current.text : '');
}

// ========================= Event wiring & lifecycle =========================
function attachVideoListeners() {
  if (!state.videoEl) return;
  state.videoEl.addEventListener('timeupdate', onTimeTick);
  state.videoEl.addEventListener('seeked', onTimeTick);
  state.videoEl.addEventListener('ratechange', () => {
    // force immediate tick on speed change
    state.lastTickAt = 0;
    onTimeTick();
  });
  state.videoEl.addEventListener('play', () => setCaptionText(''));
  state.videoEl.addEventListener('pause', () => setCaptionText(''));
}

function detachVideoListeners() {
  if (!state.videoEl) return;
  state.videoEl.removeEventListener('timeupdate', onTimeTick);
  state.videoEl.removeEventListener('seeked', onTimeTick);
  state.videoEl.removeEventListener('ratechange', () => {});
  state.videoEl.removeEventListener('play', () => {});
  state.videoEl.removeEventListener('pause', () => {});
}

function injectIfReady() {
  const player = findPlayerShell();
  const vid = findVideoEl();
  if (!player || !vid) return false;

  state.videoEl = vid;
  state.overlayEl = ensureOverlay(player);
  attachVideoListeners();
  return true;
}

function removeOverlayAndListeners() {
  detachVideoListeners();
  clearOverlay();
  state.videoEl = null;
  state.overlayEl = null;
}

function setState(next) {
  if (state.mode === next) return;
  log.info(`State: ${state.mode} → ${next}`);
  state.mode = next;
}

function stopAll(activityNote = 'stop') {
  setState(SST.MODES.IDLE);
  if (state.inflight) {
    try { state.inflight.ctrl.abort(); } catch {}
    state.inflight = null;
  }
  removeOverlayAndListeners();
  // keep cache for brief reuse, but clear if video changes in resetForNavigation
  log.info('Stopped:', activityNote);
}

function resetForNavigation() {
  stopAll('nav');
  // Clear only entries for prior video to avoid cross-video bleed
  if (state.videoId) {
    for (const k of Array.from(state.cache.keys())) {
      if (k.startsWith(`${state.videoId}|`)) state.cache.delete(k);
    }
  }
  state.videoId = getVideoIdFromUrl();
  log.info('Navigation detected. New videoId:', state.videoId);
}

// ========================= SPA detection =========================
function setupObservers() {
  // YouTube custom events (when available)
  window.addEventListener('yt-navigate-finish', () => {
    log.debug('yt-navigate-finish');
    onUrlMaybeChanged();
  });
  window.addEventListener('yt-page-data-updated', () => {
    log.debug('yt-page-data-updated');
    onUrlMaybeChanged();
  });

  // URL watcher (low frequency, cheap)
  setInterval(onUrlMaybeChanged, SST.URL_CHECK_MS);

  // DOM observer — watch for watch root/video element churn
  state.obs = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === 'childList') {
        if ([...m.addedNodes, ...m.removedNodes].some(n =>
          n?.nodeType === 1 && (n.matches?.(SST.SELECTORS.watchRoot) || n.querySelector?.(SST.SELECTORS.video))
        )) {
          log.debug('DOM changed around watch root/video.');
          onUrlMaybeChanged();
          break;
        }
      }
    }
  });
  state.obs.observe(document.body, { childList: true, subtree: true });
}

function onUrlMaybeChanged() {
  const href = location.href;
  if (href === state.lastUrl) return;
  state.lastUrl = href;

  const newVid = getVideoIdFromUrl(href);
  if (newVid !== state.videoId) {
    resetForNavigation();
    if (state.enabled && state.mode !== SST.MODES.ERROR) {
      // Try to reinject promptly
      tryStartActive();
    }
  }
}

// ========================= Start/Stop logic =========================
function tryStartActive() {
  if (!state.enabled) return log.debug('Not enabled; skip start.');
  setState(SST.MODES.ACTIVE);

  // Wait until player & video exist (SPA can be late)
  let attempts = 0;
  const MAX = 20;
  const wait = () => {
    attempts++;
    if (injectIfReady()) {
      log.info('Player ready; attached overlay and listeners.');
      // force an immediate tick to hydrate ASAP
      state.lastTickAt = 0;
      onTimeTick();
      return;
    }
    if (attempts < MAX) return setTimeout(wait, 150);
    // fail
    setState(SST.MODES.ERROR);
    log.warn('Failed to attach after retries.');
  };
  wait();
}

// ========================= Messaging from popup =========================
function setupMessageListener() {
  if (!chrome?.runtime?.onMessage) {
    log.warn('Chrome runtime messaging unavailable.');
    return;
  }
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    try {
      switch (msg?.type) {
        case 'SETTINGS_CHANGED':
          state.enabled = !!msg.settings?.enabled;
          state.language = msg.settings?.language || state.language;
          state.hint = msg.settings?.hint || state.hint;
          log.info('Settings updated', { enabled: state.enabled, language: state.language });
          if (state.enabled && state.mode === SST.MODES.IDLE) {
            tryStartActive();
          } else if (!state.enabled && state.mode !== SST.MODES.IDLE) {
            stopAll('disabled');
          }
          sendResponse?.({ ok: true });
          return true;

        case 'START_TRANSLATION':
          state.enabled = true;
          state.language = msg.settings?.language || state.language;
          state.hint = msg.settings?.hint || state.hint;
          state.videoId = getVideoIdFromUrl();
          tryStartActive();
          sendResponse?.({ ok: true });
          return true;

        case 'STOP_TRANSLATION':
          stopAll('popup stop');
          sendResponse?.({ ok: true });
          return true;

        default:
          // ignore unknown
          sendResponse?.({ ok: true, ignored: true });
          return true;
      }
    } catch (e) {
      log.error('Message handling error', e);
      setState(SST.MODES.ERROR);
      sendResponse?.({ ok: false, error: e.message });
      return true;
    }
  });
}

// ========================= Boot =========================
(function boot() {
  state.videoId = getVideoIdFromUrl();
  setupMessageListener();
  setupObservers();
  log.info('Content script ready on', location.href);
})();
