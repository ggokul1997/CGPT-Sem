/* Popup logic for Semantic Subtitle Translator (MV3)
 * Responsibilities:
 *  - Load & persist settings via chrome.storage.sync (fallback: localStorage)
 *  - Debounce writes
 *  - Update status pill (Idle/Active/Error)
 *  - Emit messages to active YouTube tab: START/STOP/SETTINGS_CHANGED
 *  - Toast errors/successes (aria-live)
 */

(() => {
  const QS = (s) => document.querySelector(s);

  const STORAGE_KEYS = {
    enabled: 'sst_enabled',
    language: 'sst_language',
    hint: 'sst_hint',
  };

  const DEFAULTS = {
    [STORAGE_KEYS.enabled]: false,
    [STORAGE_KEYS.language]: 'en',
    [STORAGE_KEYS.hint]: '',
  };

  const STATE = {
    enabled: DEFAULTS[STORAGE_KEYS.enabled],
    language: DEFAULTS[STORAGE_KEYS.language],
    hint: DEFAULTS[STORAGE_KEYS.hint],
    runtimeStatus: 'idle', // 'idle' | 'active' | 'error'
    started: false
  };

  // ---------- Storage helpers ----------
  const hasChrome = typeof chrome !== 'undefined' && chrome?.storage?.sync;

  const storageGet = async (keysObj) => {
    if (hasChrome) {
      return new Promise((resolve) => {
        chrome.storage.sync.get(keysObj, (res) => resolve(res || {}));
      });
    } else {
      const out = {};
      for (const k of Object.keys(keysObj)) {
        const raw = localStorage.getItem(k);
        out[k] = raw === null ? keysObj[k] : JSON.parse(raw);
      }
      return out;
    }
  };

  const storageSet = async (obj) => {
    if (hasChrome) {
      return new Promise((resolve) => {
        chrome.storage.sync.set(obj, () => resolve());
      });
    } else {
      for (const [k, v] of Object.entries(obj)) {
        localStorage.setItem(k, JSON.stringify(v));
      }
    }
  };

  // ---------- Debounce ----------
  const debounce = (fn, ms = 250) => {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  };

  // ---------- UI references ----------
  const $enabled = () => QS('#toggleEnabled');
  const $language = () => QS('#selectLanguage');
  const $hint = () => QS('#textHint');
  const $btn = () => QS('#btnStartStop');
  const $pill = () => QS('#statusPill');
  const $toast = () => QS('#toast');

  // ---------- UI helpers ----------
  const setPill = (status) => {
    STATE.runtimeStatus = status;
    const pill = $pill();
    pill.classList.remove('sst-pill--idle', 'sst-pill--active', 'sst-pill--error');
    if (status === 'active') {
      pill.textContent = 'Active';
      pill.classList.add('sst-pill--active');
    } else if (status === 'error') {
      pill.textContent = 'Error';
      pill.classList.add('sst-pill--error');
    } else {
      pill.textContent = 'Idle';
      pill.classList.add('sst-pill--idle');
    }
  };

  const showToast = (msg, kind = 'info') => {
    const toast = $toast();
    toast.textContent = msg;
    toast.hidden = false;
    toast.classList.remove('sst-toast--error', 'sst-toast--success');
    if (kind === 'error') toast.classList.add('sst-toast--error');
    if (kind === 'success') toast.classList.add('sst-toast--success');
    setTimeout(() => { toast.hidden = true; toast.textContent = ''; }, 2200);
  };

  const setButtonState = (started) => {
    STATE.started = started;
    const btn = $btn();
    if (started) {
      btn.textContent = 'Stop';
      btn.setAttribute('aria-label', 'Stop translating');
    } else {
      btn.textContent = 'Start';
      btn.setAttribute('aria-label', 'Start translating');
    }
  };

  const applyUI = () => {
    $enabled().checked = !!STATE.enabled;
    $language().value = STATE.language;
    $hint().value = STATE.hint;
    setButtonState(false);
    setPill('idle');
  };

  // ---------- Messaging ----------
  const sendToActiveTab = async (message) => {
    if (!hasChrome || !chrome.tabs?.query) {
      console.log('[POPUP] (no chrome API) message', message);
      return { ok: true, offline: true };
    }
    try {
      const [tab] = await new Promise((resolve) => {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs || []));
      });
      if (!tab?.id) throw new Error('No active tab.');
      return await new Promise((resolve) => {
        chrome.tabs.sendMessage(tab.id, message, (resp) => {
          const err = chrome.runtime?.lastError;
          if (err) resolve({ ok: false, error: err.message });
          else resolve(resp || { ok: true });
        });
      });
    } catch (e) {
      return { ok: false, error: e.message };
    }
  };

  const emitSettingsChanged = debounce(async () => {
    const payload = {
      type: 'SETTINGS_CHANGED',
      ts: Date.now(),
      settings: {
        enabled: !!STATE.enabled,
        language: STATE.language,
        hint: STATE.hint
      },
      source: 'popup'
    };
    const r = await sendToActiveTab(payload);
    if (!r.ok && !r.offline) setPill('error');
  }, 250);

  // ---------- Event handlers ----------
  const onToggle = async (e) => {
    STATE.enabled = !!e.currentTarget.checked;
    await storageSet({ [STORAGE_KEYS.enabled]: STATE.enabled });
    emitSettingsChanged();
  };

  const onLanguage = async (e) => {
    STATE.language = e.currentTarget.value;
    await storageSet({ [STORAGE_KEYS.language]: STATE.language });
    emitSettingsChanged();
  };

  const onHintInput = async (e) => {
    STATE.hint = e.currentTarget.value;
    await storageSet({ [STORAGE_KEYS.hint]: STATE.hint }); // still debounced for message
    emitSettingsChanged();
  };

  const onStartStop = async () => {
    const ts = Date.now();
    if (!STATE.started) {
      if (!STATE.enabled) {
        showToast('Enable translator first.', 'error');
        setPill('error');
        return;
      }
      const resp = await sendToActiveTab({
        type: 'START_TRANSLATION',
        ts,
        settings: {
          enabled: !!STATE.enabled,
          language: STATE.language,
          hint: STATE.hint
        },
        source: 'popup'
      });
      if (resp.ok) {
        setButtonState(true);
        setPill('active');
        showToast('Translation started', 'success');
      } else {
        setPill('error');
        showToast(`Start failed: ${resp.error || 'Unknown error'}`, 'error');
      }
    } else {
      const resp = await sendToActiveTab({ type: 'STOP_TRANSLATION', ts, source: 'popup' });
      if (resp.ok) {
        setButtonState(false);
        setPill('idle');
        showToast('Translation stopped');
      } else {
        setPill('error');
        showToast(`Stop failed: ${resp.error || 'Unknown error'}`, 'error');
      }
    }
  };

  const bindEvents = () => {
    $enabled().addEventListener('change', onToggle);
    $language().addEventListener('change', onLanguage);
    $hint().addEventListener('input', onHintInput);
    $btn().addEventListener('click', onStartStop);

    // Keyboard niceties
    $hint().addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        onStartStop();
      }
    });
  };

  // ---------- Init ----------
  const init = async () => {
    const initVals = await storageGet({
      [STORAGE_KEYS.enabled]: DEFAULTS[STORAGE_KEYS.enabled],
      [STORAGE_KEYS.language]: DEFAULTS[STORAGE_KEYS.language],
      [STORAGE_KEYS.hint]: DEFAULTS[STORAGE_KEYS.hint],
    });
    STATE.enabled = !!initVals[STORAGE_KEYS.enabled];
    STATE.language = initVals[STORAGE_KEYS.language] || DEFAULTS[STORAGE_KEYS.language];
    STATE.hint = initVals[STORAGE_KEYS.hint] || DEFAULTS[STORAGE_KEYS.hint];
    applyUI();
    bindEvents();
  };

  document.addEventListener('DOMContentLoaded', init);
})();
