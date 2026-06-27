// content.js — D&D Action Tracker v19
// Hybrid approach:
//   - DDB character-service API (cobalt cookie) for: name, HP tracking, conditions
//   - DOM scraping of *displayed* values for: saves, passives, AC, speed, PB, defenses
//     because custom homebrew modifiers are already baked into what DDB renders.

const SUPABASE_URL = 'https://adqnhmmgrrptiljuvnwv.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFkcW5obW1ncnJwdGlsanV2bnd2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM4MDIzNzMsImV4cCI6MjA4OTM3ODM3M30.k_pxMDRvOtBasUgqk-THJmY3GoJ0Ppgdg5ZhK2pQ4UE';

// ─── Extension context guard ──────────────────────────────────────────────────
// When Chrome reloads the extension, old content script intervals keep firing
// but chrome.* APIs throw "Extension context invalidated". We track all intervals
// and clear them when we detect this, so the page doesn't get console spam.
var _intervals = [];
var _contextAlive = true;

function safeInterval(fn, ms) {
  var id = setInterval(function() {
    if (!_contextAlive) { clearInterval(id); return; }
    try { fn(); }
    catch(e) {
      if (e && e.message && e.message.includes('Extension context invalidated')) {
        _contextAlive = false;
        _intervals.forEach(function(i) { clearInterval(i); });
        _intervals = [];
      }
    }
  }, ms);
  _intervals.push(id);
  return id;
}

function chromeSafe(fn) {
  if (!_contextAlive) return;
  try { fn(); }
  catch(e) {
    if (e && e.message && e.message.includes('Extension context invalidated')) {
      _contextAlive = false;
      _intervals.forEach(function(i) { clearInterval(i); });
      _intervals = [];
    }
  }
}

// ─── State ────────────────────────────────────────────────────────────────────
var sb          = null;
var charId      = null;
var charName    = null;
var ddbChar     = null;
var domStats    = {};   // values scraped from the rendered page
var settings    = { sessionId:'campaign-1', reactionCount:2, sanityScore:10, investitureScore:10, sanProf:false, invProf:false, ismValue:0 };
var actionState = { action:false, bonusAction:false, hastedAction:false, reactions:[], investedActions:[], hasted:false, movementUsed:0 };
var trackerInjected = false;
var tabInjected     = false;
var notesSaveTimer  = null;
var lastStatsPush   = '';
var statsInterval   = null;

// ─── Storage — per charId ─────────────────────────────────────────────────────
function sk(f) { return 'c' + charId + '_' + f; }
var SETTING_FIELDS = ['sessionId','reactionCount','sanityScore','investitureScore','sanProf','invProf','ismValue','theme'];

function loadSettings(cb) {
  chromeSafe(function() {
  chrome.storage.local.get(SETTING_FIELDS.map(sk), function(data) {
    SETTING_FIELDS.forEach(function(f) {
      var v = data[sk(f)];
      if (v !== undefined) settings[f] = v;
    });
    settings.reactionCount    = parseInt(settings.reactionCount)    || 2;
    settings.sanityScore      = parseInt(settings.sanityScore)      || 10;
    settings.investitureScore = parseInt(settings.investitureScore) || 10;
    settings.ismValue         = parseInt(settings.ismValue)         || 0;
    settings.sanProf          = !!settings.sanProf;
    settings.invProf          = !!settings.invProf;
    cb();
  });
  });
}

function saveSettings(updates) {
  var obj = {};
  Object.keys(updates).forEach(function(f) { settings[f] = updates[f]; obj[sk(f)] = updates[f]; });
  chromeSafe(function() { chrome.storage.local.set(obj); });
}

// ─── Cobalt cookie ────────────────────────────────────────────────────────────
function getCobaltToken() {
  var cookies = document.cookie.split(';');
  for (var i = 0; i < cookies.length; i++) {
    var c = cookies[i].trim();
    if (c.startsWith('CobaltSession=')) return c.slice('CobaltSession='.length);
    if (c.startsWith('cobalt_session=')) return c.slice('cobalt_session='.length);
  }
  return null;
}

// ─── DDB character API fetch (name + HP delta + conditions only) ──────────────
function fetchCharacter(id, cb) {
  var token = getCobaltToken();
  var headers = { 'Accept': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  fetch('https://character-service.dndbeyond.com/character/v5/character/' + id, {
    credentials: 'include', headers: headers
  })
  .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
  .then(function(json) {
    var char = (json && json.data) ? json.data : json;
    if (!char || !char.name) throw new Error('No character in response');
    cb(null, char);
  })
  .catch(function(e) { cb(e, null); });
}

// ─── Bad name guard ───────────────────────────────────────────────────────────
var BAD_NAMES = ['CharacterData','Character','PageProps','Unknown','Adventurer','Loading','undefined','null'];
function isBadName(name) {
  if (!name || !name.trim()) return true;
  if (BAD_NAMES.indexOf(name) !== -1) return true;
  // React component names: PascalCase, no spaces, 8+ chars
  if (/^[A-Z][a-z][a-zA-Z]{6,}$/.test(name) && name.indexOf(' ') === -1) return true;
  return false;
}

// ─── DOM scraping — reads what DDB renders, custom modifiers included ─────────
// Strategy: find a label element whose text matches, then find the adjacent value.
// DDB uses various layouts but always has label+value pairs we can target.

function scrapeAll() {
  var s = {};

  // ── Walk the whole doc for label→value pairs ─────────────────────────────
  // Build a map of text → nearby numbers for fast lookup
  function nearbyNumber(labelEl) {
    // Check next sibling
    var ns = labelEl.nextElementSibling;
    if (ns) {
      var t = ns.textContent.trim();
      if (/^[+\-]?\d+(\s*ft\.?)?$/.test(t)) return t.replace(/\s*ft\.?/, '');
    }
    // Check parent's children
    var par = labelEl.parentElement;
    if (!par) return null;
    var children = par.querySelectorAll('*');
    for (var i = 0; i < children.length; i++) {
      if (children[i] === labelEl) continue;
      if (children[i].children.length > 0) continue;
      var v = children[i].textContent.trim();
      if (/^[+\-]?\d+$/.test(v)) return v;
      if (/^\d+ ft\.?$/.test(v)) return v.replace(/\s*ft\.?/, '');
    }
    return null;
  }

  // Scan all leaf elements for known labels
  var allLeaves = document.querySelectorAll('*');
  var labelMap = {};  // normalised label → value
  for (var i = 0; i < allLeaves.length; i++) {
    var el = allLeaves[i];
    if (el.children.length > 0) continue;
    var txt = el.textContent.trim().toUpperCase().replace(/\s+/g, ' ');
    if (txt.length === 0 || txt.length > 40) continue;
    if (!labelMap[txt]) {
      var val = nearbyNumber(el);
      if (val) labelMap[txt] = val;
    }
  }

  // ── Combat stats (displayed in the header area) ──────────────────────────
  s.ac    = labelMap['ARMOR CLASS'] || labelMap['AC'] || null;
  s.pb    = labelMap['PROFICIENCY BONUS'] || labelMap['PROF BONUS'] || labelMap['PROFICIENCY'] || null;
  // Speed — could say "WALKING", "SPEED", "WALK SPEED" etc.
  s.speed = labelMap['WALKING'] || labelMap['SPEED'] || labelMap['WALK SPEED'] || labelMap['WALKING SPEED'] || null;
  // Strip "ft" if it leaked in
  if (s.speed) s.speed = parseInt(s.speed) || null;
  // Initiative
  s.initiative = labelMap['INITIATIVE'] || null;

  // ── Passives ──────────────────────────────────────────────────────────────
  s.passivePerception    = labelMap['PASSIVE PERCEPTION'] || labelMap['PASS. PERCEPTION'] || null;
  s.passiveInvestigation = labelMap['PASSIVE INVESTIGATION'] || labelMap['PASS. INVESTIGATION'] || null;
  s.passiveInsight       = labelMap['PASSIVE INSIGHT'] || labelMap['PASS. INSIGHT'] || null;

  // ── Saving throws ─────────────────────────────────────────────────────────
  // Strategy: find the "SAVING THROWS" heading, then scrape within its container.
  // DDB renders saves on the character sheet left panel as abbr + modifier pairs.
  var saves = {};
  var SAVE_ABBRS = ['STR','DEX','CON','INT','WIS','CHA'];

  // Find the saving throws container by looking for its heading text
  var saveContainer = null;
  var allEls = document.querySelectorAll('*');
  for (var si = 0; si < allEls.length; si++) {
    var sel = allEls[si];
    if (sel.children.length > 0) continue;
    var stxt = sel.textContent.trim().toUpperCase();
    if (stxt === 'SAVING THROWS' || stxt === 'SAVING THROW MODIFIERS') {
      // Walk up to find a container that holds the actual save values
      var parent = sel.parentElement;
      for (var up = 0; up < 5 && parent; up++) {
        // The right container has multiple children with abbr+value pairs
        var allText = parent.textContent;
        var hasMultipleSaves = 0;
        SAVE_ABBRS.forEach(function(a) { if (allText.indexOf(a) !== -1) hasMultipleSaves++; });
        if (hasMultipleSaves >= 4) { saveContainer = parent; break; }
        parent = parent.parentElement;
      }
      if (saveContainer) break;
    }
  }

  if (saveContainer) {
    // Each save is rendered as a small block with [prof dot?] [abbr] [+modifier]
    // Walk leaf elements inside this container pairing abbrs with adjacent modifiers
    var saveLeaves = saveContainer.querySelectorAll('*');
    var lastAbbr = null;
    for (var sk2 = 0; sk2 < saveLeaves.length; sk2++) {
      var skel = saveLeaves[sk2];
      if (skel.children.length > 0) continue;
      var stv = skel.textContent.trim().toUpperCase();
      if (SAVE_ABBRS.indexOf(stv) !== -1) {
        lastAbbr = stv;
      } else if (lastAbbr && /^[+\-]\d+$/.test(stv)) {
        if (!saves[lastAbbr]) saves[lastAbbr] = stv;
        lastAbbr = null;
      } else if (stv && !/^[+\-]?\d+$/.test(stv)) {
        // Non-numeric, non-abbr text resets the abbr search
        lastAbbr = null;
      }
    }
  }

  // Last-resort fallback: use label map if we still don't have saves
  // Look for "STR SAVING THROW", "STRENGTH SAVING THROW" etc.
  if (Object.keys(saves).length < 3) {
    var saveLabels = {
      'STRENGTH': 'STR', 'DEXTERITY': 'DEX', 'CONSTITUTION': 'CON',
      'INTELLIGENCE': 'INT', 'WISDOM': 'WIS', 'CHARISMA': 'CHA'
    };
    Object.keys(saveLabels).forEach(function(full) {
      var abbr2 = saveLabels[full];
      if (!saves[abbr2]) {
        var v = labelMap[full + ' SAVING THROW'] || labelMap[abbr2 + ' SAVE'] || labelMap[abbr2 + ' SAVING THROW'];
        if (v) saves[abbr2] = v;
      }
    });
  }
  s.saves = saves;

  // ── HP ────────────────────────────────────────────────────────────────────
  // DDB renders current HP as an input and max HP as static text.
  // The input may report .value = "" when not focused if DDB uses a controlled
  // React input — in that case fall back to placeholder or aria attributes.
  var hpSection = document.querySelector(
    '.ct-health-summary, [class*="health-summary"], [class*="HealthSummary"], [class*="HitPoints"]'
  );

  if (hpSection) {
    // Try all number inputs in the section
    var hpInputs = hpSection.querySelectorAll('input[type="number"], input:not([type])');
    for (var hi = 0; hi < hpInputs.length; hi++) {
      var hpInp = hpInputs[hi];
      // value, then defaultValue, then placeholder
      var hpVal = hpInp.value || hpInp.defaultValue || hpInp.placeholder || hpInp.getAttribute('value') || '';
      if (hpVal !== '' && !isNaN(parseInt(hpVal))) {
        if (hi === 0) s.hpCurrentInput = String(parseInt(hpVal));
        if (hi === 1) s.hpTempInput    = String(parseInt(hpVal));
      }
    }
    // Max HP — look for "/ NNN" pattern or a MAX-labelled element
    var maxMatch = hpSection.textContent.match(/\/\s*(\d+)/);
    if (maxMatch) s.hpMax = maxMatch[1];
    var maxEl = hpSection.querySelector('[class*="max" i], [class*="Max"]');
    if (maxEl && maxEl.children.length === 0) {
      var mx = maxEl.textContent.replace(/[^0-9]/g,'').trim();
      if (mx) s.hpMax = mx;
    }
  }

  // Additional HP current fallbacks — DDB renders the current HP number prominently
  if (!s.hpCurrentInput || s.hpCurrentInput === '') {
    // Try aria-label approaches
    var curInput = document.querySelector('[aria-label*="current" i] input, input[aria-label*="current" i]');
    if (curInput) s.hpCurrentInput = curInput.value || curInput.placeholder || '';

    // Try reading the "CURRENT" label from the HP area via labelMap
    if (!s.hpCurrentInput || s.hpCurrentInput === '') {
      var curVal = labelMap['CURRENT'] || labelMap['HP'] || labelMap['HIT POINTS'];
      if (curVal && parseInt(curVal) >= 0) s.hpCurrentInput = curVal;
    }

    // Last resort: find any input near "CURRENT" or "HIT POINTS" text
    if (!s.hpCurrentInput || s.hpCurrentInput === '') {
      var allInputs = document.querySelectorAll('input[type="number"]');
      for (var ii = 0; ii < allInputs.length; ii++) {
        var inp = allInputs[ii];
        var nearText = (inp.closest('[class*="health"], [class*="Health"], [class*="hp"], [class*="HP"]') || {textContent:''}).textContent;
        if (nearText && nearText.length < 500) {
          var v3 = inp.value || inp.defaultValue || '';
          if (v3 !== '' && parseInt(v3) >= 0) {
            s.hpCurrentInput = String(parseInt(v3));
            break;
          }
        }
      }
    }
  }

  // Max HP fallback via labelMap
  if (!s.hpMax) {
    s.hpMax = labelMap['MAX'] || null;
  }

  // ── Defenses ─────────────────────────────────────────────────────────────
  var defSection = document.querySelector(
    '.ct-defenses-summary, [class*="defenses-summary"], [class*="DefensesSummary"]'
  );
  if (defSection) {
    var defTypes = [];
    var defLeaves = defSection.querySelectorAll('*');
    defLeaves.forEach(function(el) {
      if (el.children.length > 0) return;
      var t = el.textContent.trim().replace(/\*/g,'').trim();
      if (!t || t.length < 2 || t.length > 30) return;
      if (/^(DEFENSES|RESISTANCES|IMMUNITIES|VULNERABILITIES|NONE)$/i.test(t)) return;
      defTypes.push(t);
    });
    if (defTypes.length === 0) {
      var raw = defSection.textContent.trim();
      defTypes = raw.split(/\*+/).map(function(x){ return x.trim(); }).filter(function(x){
        return x.length > 1 && !/^(DEFENSES|RESISTANCES|IMMUNITIES|NONE)$/i.test(x);
      });
    }
    s.defenses = [...new Set(defTypes)].join(', ') || null;
  }

  return s;
}

// ─── Supabase helpers ─────────────────────────────────────────────────────────
function pName()    { return charName || 'Unknown'; }
function pSession() { return settings.sessionId || 'campaign-1'; }
function pIsm()     { return Math.max(0, parseInt(settings.ismValue) || 0); }

function fmtMod(n) { return (n >= 0 ? '+' : '') + n; }
function modOf(score) { return Math.floor(((parseInt(score)||10) - 10) / 2); }

function buildSaves(domSaves, pb) {
  var saves = {};
  ['STR','DEX','CON','INT','WIS','CHA'].forEach(function(s) {
    saves[s] = domSaves[s] || '+0';
  });
  var sanSave = modOf(settings.sanityScore)     + (settings.sanProf ? pb : 0);
  var invSave = modOf(settings.investitureScore) + (settings.invProf ? pb : 0);
  saves['SAN'] = fmtMod(sanSave) + (settings.sanProf ? '●' : '');
  saves['INV'] = fmtMod(invSave) + (settings.invProf ? '●' : '');
  return saves;
}

function doPushStats() {
  if (!sb || !charName) return;
  var d  = domStats;
  var pb = parseInt(d.pb) || 2;

  var sheetStats = {
    ac:                   d.ac        || '',
    speed:                d.speed     || 30,
    profBonus:            pb,
    passivePerception:    d.passivePerception    || null,
    passiveInvestigation: d.passiveInvestigation || null,
    passiveInsight:       d.passiveInsight       || null,
    savingThrows:         buildSaves(d.saves || {}, pb),
  };

  // HP: prefer DOM current HP (live), use API for max if DOM fails
  var hpCurrent = d.hpCurrentInput != null ? String(d.hpCurrentInput) : '';
  var hpMax     = d.hpMax != null ? String(d.hpMax) : '';
  var hpTemp    = d.hpTempInput && d.hpTempInput !== '' ? String(d.hpTempInput) : '0';

  // If API char data is available, use it to verify max HP
  if (ddbChar && (!hpMax || hpMax === '0')) {
    var pb2 = pb;
    var conScore = 10;
    if (ddbChar.stats) {
      ddbChar.stats.forEach(function(s) { if (s.id === 3) conScore = s.value || 10; });
    }
    var conMod = Math.floor((conScore - 10) / 2);
    var level  = 0;
    (ddbChar.classes||[]).forEach(function(c) { level += c.level || 0; });
    hpMax = String((ddbChar.baseHitPoints || 0) + conMod * level + (ddbChar.bonusHitPoints || 0));
  }

  var combatStats = {
    speed:      d.speed || 30,
    hpCurrent:  hpCurrent,
    hpMax:      hpMax,
    hpTemp:     hpTemp,
    defenses:   d.defenses || null,
    initiative: d.initiative || '+0',
  };

  var json = JSON.stringify(sheetStats) + JSON.stringify(combatStats);
  if (json === lastStatsPush) return;
  lastStatsPush = json;

  sb.from('action_tracker').upsert({
    player_name:  pName(), session_id: pSession(),
    sheet_stats:  sheetStats, combat_stats: combatStats,
    proficiencies: { sanProf: settings.sanProf, invProf: settings.invProf },
    last_updated: new Date().toISOString()
  }, { onConflict: 'player_name,session_id' }).then(function(){}).catch(function(){});
}

// Run DOM scrape + push
function scrapeAndPush() {
  domStats = scrapeAll();
  if (domStats.speed) updateMovementMax(domStats.speed);
  refreshSaveChips();
  doPushStats();
}

// Watch HP inputs for immediate change — DDB's React inputs update .value on each keystroke
// but our interval might miss it. Observe the value attribute changes directly.
var _hpObserver = null;
function watchHPInputs() {
  if (_hpObserver) return; // already watching

  function attachToInput(inp) {
    // Use both 'input' event and MutationObserver on value attribute
    inp.addEventListener('input', function() {
      clearTimeout(_hpDebounce);
      _hpDebounce = setTimeout(scrapeAndPush, 600);
    });
    inp.addEventListener('change', function() {
      clearTimeout(_hpDebounce);
      _hpDebounce = setTimeout(scrapeAndPush, 600);
    });
  }

  // Find and attach to existing HP inputs
  var hpSection = document.querySelector(
    '.ct-health-summary, [class*="health-summary"], [class*="HealthSummary"], [class*="HitPoints"]'
  );
  if (hpSection) {
    hpSection.querySelectorAll('input').forEach(attachToInput);
  }

  // Also watch for new HP inputs being mounted by React
  _hpObserver = new MutationObserver(function() {
    var hpSec2 = document.querySelector(
      '.ct-health-summary, [class*="health-summary"], [class*="HealthSummary"], [class*="HitPoints"]'
    );
    if (hpSec2) hpSec2.querySelectorAll('input').forEach(function(inp) {
      if (!inp._atWatched) { inp._atWatched = true; attachToInput(inp); }
    });
  });
  _hpObserver.observe(document.body, { childList: true, subtree: true });
}
var _hpDebounce = null;

// ─── Boot ─────────────────────────────────────────────────────────────────────
function init() {
  var m = window.location.pathname.match(/\/characters\/(\d+)/);
  if (!m) return;
  charId = m[1];

  loadSettings(function() {
    startObserver();
    setTimeout(tryInject, 400);
    setTimeout(tryInject, 1200);
    setTimeout(tryInject, 3000);

    // Fetch char via API for name + HP source of truth
    fetchCharacter(charId, function(err, char) {
      if (err || !char) { console.warn('[AT] API fetch failed:', err); return; }
      if (isBadName(char.name)) { console.warn('[AT] Bad name:', char.name); return; }

      ddbChar  = char;
      charName = char.name;

      // Update name in tracker
      var nameEl = document.querySelector('.at-player-name');
      if (nameEl) nameEl.textContent = charName;

      // Connect Supabase
      sb = createSupabaseClient(SUPABASE_URL, SUPABASE_KEY);
      ensureRow()
        .then(loadState)
        .then(function() {
          startPolling();
          scrapeAndPush();
          watchHPInputs(); // immediate HP change detection
          statsInterval = safeInterval(scrapeAndPush, 8000);
        })
        .catch(function(e) { console.warn('[AT]', e); });

      // Re-fetch from API every 15s just for HP delta (removedHitPoints is reliable)
      safeInterval(function() {
        fetchCharacter(charId, function(e2, c2) {
          if (e2 || !c2 || isBadName(c2.name)) return;
          ddbChar = c2;
          scrapeAndPush();
        });
      }, 15000);
    });
  });
}

// ─── Supabase ops ─────────────────────────────────────────────────────────────
function defaultState() {
  var r = parseInt(settings.reactionCount)||2;
  var reactions=[], invested=[];
  for(var i=0;i<r;i++) reactions.push(false);
  for(var j=0;j<pIsm();j++) invested.push(false);
  return {action:false,bonusAction:false,hastedAction:false,reactions:reactions,investedActions:invested,hasted:false,movementUsed:0};
}

async function ensureRow() {
  var res = await sb.from('action_tracker').select('id').eq('player_name',pName()).eq('session_id',pSession()).single();
  if (res.error && res.error.code === 'PGRST116') {
    var fresh = defaultState();
    await sb.from('action_tracker').insert({
      player_name:pName(), session_id:pSession(), ism_value:pIsm(),
      action_state:fresh, sheet_stats:{}, combat_stats:{}, custom_notes:'', last_updated:new Date().toISOString()
    });
    actionState = fresh;
  }
}

async function loadState() {
  var res = await sb.from('action_tracker').select('action_state').eq('player_name',pName()).eq('session_id',pSession()).single();
  if (!res.error && res.data) { actionState = res.data.action_state || defaultState(); refreshUI(); }
}

function pushState() {
  if (!sb) return;
  sb.from('action_tracker').upsert({
    player_name:pName(), session_id:pSession(), ism_value:pIsm(),
    action_state:actionState, last_updated:new Date().toISOString()
  },{onConflict:'player_name,session_id'}).then(function(){}).catch(function(){});
}

function pushNotes(html) {
  if (!sb) return;
  sb.from('action_tracker').upsert({
    player_name:pName(), session_id:pSession(), ism_value:pIsm(),
    custom_notes:html, last_updated:new Date().toISOString()
  },{onConflict:'player_name,session_id'}).then(function(){}).catch(function(){});
}

function startPolling() {
  // Track the dm_reset_id we last handled.
  // The DM increments this integer on every New Round.
  // We never write dm_reset_id ourselves — only the DM does.
  // This makes event identity stable regardless of last_updated changes.
  var lastHandledResetId = -1;

  safeInterval(function() {
    if (!sb) return;
    sb.from('action_tracker').select('action_state,dm_reset,dm_reset_id')
      .eq('player_name', pName()).eq('session_id', pSession()).single()
      .then(function(res) {
        if (res.error || !res.data) return;

        var resetId = res.data.dm_reset_id || 0;

        if (res.data.dm_reset && resetId !== lastHandledResetId) {
          // New reset event — handle it exactly once
          lastHandledResetId = resetId;

          var wasHasted = actionState.hasted;
          actionState = defaultState();
          actionState.hasted = wasHasted;
          refreshUI();
          showFlash();

          // Clear dm_reset. Do NOT write last_updated or dm_reset_id —
          // only touch dm_reset and action_state so we don't pollute the event ID.
          sb.from('action_tracker')
            .update({ dm_reset: false, action_state: actionState })
            .eq('player_name', pName()).eq('session_id', pSession())
            .then(function(){}).catch(function(){});

        } else if (!res.data.dm_reset) {
          // Normal sync — apply remote state if it differs
          var remote = res.data.action_state || defaultState();
          if (JSON.stringify(remote) !== JSON.stringify(actionState)) {
            actionState = remote;
            refreshUI();
          }
        }
        // If dm_reset=true but resetId === lastHandledResetId,
        // we already handled this round — our clear just hasn't committed yet. Do nothing.
      }).catch(function(){});
  }, 3000);
}

// ─── Observer ─────────────────────────────────────────────────────────────────
function startObserver() {
  var pending = false;
  var obs = new MutationObserver(function() {
    if (trackerInjected && !document.getElementById('dnd-action-tracker')) {
      trackerInjected = false; tabInjected = false;
    }
    if (pending) return;
    pending = true;
    requestAnimationFrame(function() { pending = false; tryInject(); });
  });
  obs.observe(document.body, { childList:true, subtree:true });
}

function tryInject() {
  if (!trackerInjected) injectTracker();
  if (trackerInjected && !tabInjected) injectTab();
}

function findTabBar() {
  var known = document.querySelector('.ct-action-detail__tab-list,.ddbc-tab-list');
  if (known) return known;
  var lists = document.querySelectorAll('[role="tablist"]');
  for (var i=0;i<lists.length;i++) {
    var el=lists[i]; if(el.children.length<3||el.children.length>20) continue;
    for(var j=0;j<el.children.length;j++) { if(el.children[j].textContent.trim().toUpperCase()==='ALL') return el; }
  }
  var btns=document.querySelectorAll('button,[role="tab"]');
  for(var k=0;k<btns.length;k++){
    if(btns[k].textContent.trim().toUpperCase()!=='ALL') continue;
    var par=btns[k].parentElement; if(!par||par.children.length<3) continue;
    for(var m2=0;m2<par.children.length;m2++){ if(par.children[m2].textContent.toUpperCase().includes('ATTACK')) return par; }
  }
  return null;
}

function findScrollContainer(tabBar) {
  var sib=tabBar.nextElementSibling;
  while(sib){ var cs=window.getComputedStyle(sib); if(cs.overflowY==='auto'||cs.overflowY==='scroll') return sib; sib=sib.nextElementSibling; }
  var el=tabBar.parentElement;
  for(var i=0;i<6&&el&&el!==document.body;i++){ var cs2=window.getComputedStyle(el); if(cs2.overflowY==='auto'||cs2.overflowY==='scroll') return el; el=el.parentElement; }
  return null;
}

function injectTracker() {
  if(trackerInjected) return;
  if(document.getElementById('dnd-action-tracker')){ trackerInjected=true; return; }
  var tabBar=findTabBar(); if(!tabBar) return;
  trackerInjected=true;
  var panel=document.createElement('div'); panel.id='dnd-action-tracker';
  panel.innerHTML=buildHTML();
  var scrollEl=findScrollContainer(tabBar);
  if(scrollEl) scrollEl.insertBefore(panel,scrollEl.firstChild);
  else tabBar.insertAdjacentElement('afterend',panel);
  attachEvents(); refreshUI(); loadNotes();
  // Refresh save chips after a tick — domStats.pb may not be populated yet
  // when buildHTML runs, but scrapeAndPush will have it within seconds
  setTimeout(refreshSaveChips, 100);
  setTimeout(refreshSaveChips, 2000); // second attempt after first scrape completes
}

function injectTab() {
  if(tabInjected) return;
  if(document.getElementById('at-tracker-tab')){ tabInjected=true; return; }
  var tabBar=findTabBar(); if(!tabBar) return;
  var allTabs=tabBar.querySelectorAll('button,[role="tab"]'), firstTab=null;
  for(var t=0;t<allTabs.length;t++){ if(allTabs[t].id!=='at-tracker-tab'){ firstTab=allTabs[t]; break; } }
  if(!firstTab) return;
  tabInjected=true;
  var tab=document.createElement('button');
  tab.id='at-tracker-tab'; tab.className=firstTab.className;
  tab.classList.add('at-tracker-nav-tab'); tab.setAttribute('role','tab');
  tab.textContent='TRACKER'; tab.title='Jump to Action Tracker';
  tabBar.insertBefore(tab,tabBar.firstChild);
  tab.addEventListener('click',function(e){
    e.preventDefault(); e.stopPropagation();
    var p=document.getElementById('dnd-action-tracker'); if(!p) return;
    p.scrollIntoView({behavior:'smooth',block:'start'});
    p.classList.add('at-panel-highlight');
    setTimeout(function(){ p.classList.remove('at-panel-highlight'); },900);
  });
}

// ─── Build tracker HTML ────────────────────────────────────────────────────────
function buildHTML() {
  var ism=pIsm(), reactions=settings.reactionCount||2;
  var name=charName||'Loading…';
  var sanScore=settings.sanityScore||10, invScore=settings.investitureScore||10;
  var pb=(domStats&&domStats.pb)?parseInt(domStats.pb):0;
  var sanSave=modOf(sanScore)+(settings.sanProf?pb:0);
  var invSave=modOf(invScore)+(settings.invProf?pb:0);
  var speed=(domStats&&domStats.speed)||30;
  var theme=settings.theme||autoDetectTheme();

  var invested='';
  for(var i=0;i<ism;i++) invested+='<button class="at-slot at-invested" data-idx="'+i+'"><span class="at-slot-icon">✦</span><span class="at-slot-label">INV '+(i+1)+'</span></button>';
  var reacts='';
  for(var j=0;j<reactions;j++) reacts+='<button class="at-slot at-react" data-ridx="'+j+'"><span class="at-slot-icon">↺</span><span class="at-slot-label">REACT '+(j+1)+'</span></button>';

  var settingsPanel=
    '<div class="at-settings-panel" id="at-settings-panel" style="display:none">'+
      '<div class="at-settings-grid">'+
        '<div class="at-settings-group"><label class="at-settings-label">Campaign / Session ID</label><input class="at-settings-input" id="at-s-session" type="text" value="'+esc(settings.sessionId||'campaign-1')+'"/></div>'+
        '<div class="at-settings-group"><label class="at-settings-label">Reactions</label><input class="at-settings-input" id="at-s-reactions" type="number" min="1" max="6" value="'+(settings.reactionCount||2)+'"/></div>'+
        '<div class="at-settings-group"><label class="at-settings-label">Sanity Score</label><input class="at-settings-input" id="at-s-san" type="number" min="1" max="30" value="'+sanScore+'"/></div>'+
        '<div class="at-settings-group"><label class="at-settings-label">Investiture Score</label><input class="at-settings-input" id="at-s-inv" type="number" min="1" max="30" value="'+invScore+'"/></div>'+
        '<div class="at-settings-group at-settings-full">'+
          '<label class="at-settings-check"><input type="checkbox" id="at-s-sanprof"'+(settings.sanProf?' checked':'')+'/> Proficient in Sanity saves</label>'+
          '<label class="at-settings-check"><input type="checkbox" id="at-s-invprof"'+(settings.invProf?' checked':'')+'/> Proficient in Investiture saves</label>'+
        '</div>'+
        '<div class="at-settings-group at-settings-full">'+
          '<label class="at-settings-label">Theme</label>'+
          '<div style="display:flex;gap:4px;margin-top:2px">'+
            '<button class="at-theme-btn'+(theme==='dark'?' at-theme-active':'')+'" data-theme="dark">⚔ Dark</button>'+
            '<button class="at-theme-btn'+(theme==='light'?' at-theme-active':'')+'" data-theme="light">☀ Light</button>'+
            '<button class="at-theme-btn'+(theme==='slate'?' at-theme-active':'')+'" data-theme="slate">🌙 Slate</button>'+
          '</div>'+
        '</div>'+
      '</div>'+
      '<button class="at-settings-save" id="at-settings-save">✓ Save Settings</button>'+
    '</div>';

  return '<div class="at-panel">'+
    '<div class="at-header">'+
      '<div class="at-header-left"><span class="at-sword">⚔</span><span class="at-title">Action Tracker</span><span class="at-player-name">'+esc(name)+'</span></div>'+
      '<div class="at-header-right">'+
        '<button class="at-settings-btn" id="at-settings-btn" title="Settings">⚙</button>'+
        '<button class="at-haste-toggle" id="at-haste-btn" title="Toggle Haste"><span class="at-haste-icon">⚡⚡</span><span class="at-haste-label">HASTE</span></button>'+
        '<span class="at-status-dot at-online"></span><span class="at-status-label">Live</span>'+
      '</div>'+
    '</div>'+
    settingsPanel+
    '<div class="at-scores-row">'+
      '<div class="at-score-chip at-score-san" id="at-chip-SAN" title="Click to edit Sanity score">'+
        '<span class="at-score-chip-mod" id="at-mod-SAN">'+modStr(sanScore)+'</span>'+
        '<span class="at-score-chip-val" id="at-score-SAN">'+sanScore+'</span>'+
        '<span class="at-score-chip-label">SANITY</span>'+
      '</div>'+
      '<div class="at-score-chip at-score-inv" id="at-chip-INV" title="Click to edit Investiture (sets ISM)">'+
        '<span class="at-score-chip-mod" id="at-mod-INV">'+modStr(invScore)+'</span>'+
        '<span class="at-score-chip-val" id="at-score-INV">'+invScore+'</span>'+
        '<span class="at-score-chip-label">INVESTITURE</span>'+
      '</div>'+
      '<div class="at-save-chips">'+
        '<div class="at-save-chip at-save-san"><span class="at-save-chip-val" id="at-san-save">'+fmtMod(sanSave)+(settings.sanProf?' ●':'')+'</span><span class="at-save-chip-label">SAN SAVE</span></div>'+
        '<div class="at-save-chip at-save-inv"><span class="at-save-chip-val" id="at-inv-save">'+fmtMod(invSave)+(settings.invProf?' ●':'')+'</span><span class="at-save-chip-label">INV SAVE</span></div>'+
      '</div>'+
      '<div class="at-score-note">Click scores to edit · Investiture mod = ISM · ● = prof</div>'+
    '</div>'+
    '<div class="at-slots-row" id="at-slots-row">'+
      '<button class="at-slot at-action" id="at-action"><span class="at-slot-icon">⚡</span><span class="at-slot-label">ACTION</span></button>'+
      '<div id="at-hasted-wrap" style="display:none"><button class="at-slot at-hasted-action" id="at-hasted-action"><span class="at-slot-icon">⚡</span><span class="at-slot-label">HASTE</span></button></div>'+
      '<button class="at-slot at-bonus" id="at-bonus"><span class="at-slot-icon">✦</span><span class="at-slot-label">BONUS</span></button>'+
      reacts+(ism>0?'<div class="at-divider"></div>'+invested:'')+
    '</div>'+
    '<div class="at-movement-row">'+
      '<span class="at-move-label">🏃 Movement</span>'+
      '<div class="at-move-control">'+
        '<button class="at-move-btn" id="at-move-down">−</button>'+
        '<div class="at-move-display"><span class="at-move-value" id="at-move-value">0</span><span class="at-move-max" id="at-move-max">/ '+speed+' ft</span></div>'+
        '<button class="at-move-btn" id="at-move-up">+</button>'+
      '</div>'+
      '<input type="range" class="at-move-slider" id="at-move-slider" min="0" max="'+speed+'" step="5" value="0"/>'+
    '</div>'+
    '<div class="at-notes-section">'+
      '<div class="at-notes-header">'+
        '<span class="at-notes-title">📝 Notes</span>'+
        '<div class="at-notes-toolbar">'+
          '<button class="at-notes-fmt" data-cmd="bold"><b>B</b></button>'+
          '<button class="at-notes-fmt" data-cmd="italic"><i>I</i></button>'+
          '<button class="at-notes-fmt" data-cmd="underline"><u>U</u></button>'+
        '</div>'+
        '<button class="at-notes-toggle" id="at-notes-toggle">▲</button>'+
      '</div>'+
      '<div class="at-notes-body" id="at-notes-body">'+
        '<div class="at-notes-editor" id="at-notes-editor" contenteditable="true" spellcheck="true" placeholder="Add notes, abilities, reminders…"></div>'+
      '</div>'+
    '</div>'+
    '<div class="at-reset-flash" id="at-reset-flash">🎲 New round — actions reset by DM</div>'+
  '</div>';
}

function modStr(s){var n=Math.floor(((parseInt(s)||10)-10)/2);return(n>=0?'+':'')+n;}
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

function updateMovementMax(speed) {
  if(!speed) return;
  var slider=document.getElementById('at-move-slider');
  var maxEl=document.getElementById('at-move-max');
  if(slider&&slider.max!=speed) slider.max=speed;
  if(maxEl) maxEl.textContent='/ '+speed+' ft';
}

function refreshSaveChips() {
  var pb=(domStats&&domStats.pb)?parseInt(domStats.pb):0;
  var san=modOf(settings.sanityScore)+(settings.sanProf?pb:0);
  var inv=modOf(settings.investitureScore)+(settings.invProf?pb:0);
  var ss=document.getElementById('at-san-save'),is=document.getElementById('at-inv-save');
  if(ss) ss.textContent=fmtMod(san)+(settings.sanProf?' ●':'');
  if(is) is.textContent=fmtMod(inv)+(settings.invProf?' ●':'');
}

// ─── Events ───────────────────────────────────────────────────────────────────
function attachEvents() {
  var ism=pIsm(), reactions=settings.reactionCount||2;
  document.getElementById('at-action')?.addEventListener('click',function(){toggle('action');});
  document.getElementById('at-bonus')?.addEventListener('click',function(){toggle('bonusAction');});
  document.getElementById('at-hasted-action')?.addEventListener('click',function(){toggle('hastedAction');});
  document.getElementById('at-haste-btn')?.addEventListener('click',toggleHaste);
  for(var i=0;i<reactions;i++)(function(idx){document.querySelector('.at-react[data-ridx="'+idx+'"]')?.addEventListener('click',function(){toggleReaction(idx);});})(i);
  for(var j=0;j<ism;j++)(function(idx){document.querySelector('.at-invested[data-idx="'+idx+'"]')?.addEventListener('click',function(){toggleInvested(idx);});})(j);
  var slider=document.getElementById('at-move-slider');
  var btnUp=document.getElementById('at-move-up');
  var btnDown=document.getElementById('at-move-down');
  if(slider) slider.addEventListener('input',function(){actionState.movementUsed=parseInt(slider.value)||0;updateMovementDisplay();pushState();});
  if(btnUp)   btnUp.addEventListener('click',function(){var max=parseInt(slider&&slider.max||30);actionState.movementUsed=Math.min(max,(actionState.movementUsed||0)+5);updateMovementDisplay();pushState();});
  if(btnDown) btnDown.addEventListener('click',function(){actionState.movementUsed=Math.max(0,(actionState.movementUsed||0)-5);updateMovementDisplay();pushState();});
  attachScoreChip('SAN','sanityScore','#00a8d8');
  attachScoreChip('INV','investitureScore','#00c87a');
  attachSettingsPanel();
  attachNotesEvents();
}

function autoDetectTheme() {
  // DDB's light mode adds a 'light' class or sets a light background on body/html
  var body = document.body;
  var bg = window.getComputedStyle(body).backgroundColor;
  // Light mode: body background is white-ish (high luminance)
  var m = bg.match(/rgb\((\d+),\s*(\d+),\s*(\d+)/);
  if (m) {
    var lum = (parseInt(m[1]) * 0.299 + parseInt(m[2]) * 0.587 + parseInt(m[3]) * 0.114);
    if (lum > 180) return 'light';
  }
  return 'dark';
}

function applyTheme(theme) {
  var panel = document.getElementById('dnd-action-tracker');
  if (!panel) return;
  panel.setAttribute('data-at-theme', theme || 'dark');
  // Update active button highlight
  document.querySelectorAll('.at-theme-btn').forEach(function(btn) {
    btn.classList.toggle('at-theme-active', btn.dataset.theme === theme);
  });
}

function attachSettingsPanel() {
  var btn=document.getElementById('at-settings-btn');
  var panel=document.getElementById('at-settings-panel');
  var save=document.getElementById('at-settings-save');
  if(!btn||!panel) return;

  // Apply saved (or auto-detected) theme immediately on inject
  applyTheme(settings.theme || autoDetectTheme());

  btn.addEventListener('click',function(){
    var open=panel.style.display!=='none';
    panel.style.display=open?'none':'block';
    btn.classList.toggle('at-settings-btn-active',!open);
  });

  // Theme buttons — instant, no need to click Save
  document.querySelectorAll('.at-theme-btn').forEach(function(btn2) {
    btn2.addEventListener('click', function() {
      saveSettings({ theme: btn2.dataset.theme });
      applyTheme(btn2.dataset.theme);
    });
  });

  if(save) save.addEventListener('click',function(){
    var newSession=(document.getElementById('at-s-session')?.value||'campaign-1').trim();
    var newReactions=Math.max(1,Math.min(6,parseInt(document.getElementById('at-s-reactions')?.value)||2));
    var newSan=Math.max(1,Math.min(30,parseInt(document.getElementById('at-s-san')?.value)||10));
    var newInv=Math.max(1,Math.min(30,parseInt(document.getElementById('at-s-inv')?.value)||10));
    var newSanProf=!!document.getElementById('at-s-sanprof')?.checked;
    var newInvProf=!!document.getElementById('at-s-invprof')?.checked;
    var newIsm=Math.max(0,Math.floor((newInv-10)/2));
    saveSettings({sessionId:newSession,reactionCount:newReactions,sanityScore:newSan,investitureScore:newInv,sanProf:newSanProf,invProf:newInvProf,ismValue:newIsm});
    var svEl=document.getElementById('at-score-SAN'),smEl=document.getElementById('at-mod-SAN');
    var ivEl=document.getElementById('at-score-INV'),imEl=document.getElementById('at-mod-INV');
    if(svEl) svEl.textContent=newSan; if(smEl) smEl.textContent=modStr(newSan);
    if(ivEl) ivEl.textContent=newInv; if(imEl) imEl.textContent=modStr(newInv);
    // Update settings panel inputs too
    var si=document.getElementById('at-s-san'); if(si) si.value=newSan;
    var ii=document.getElementById('at-s-inv'); if(ii) ii.value=newInv;
    refreshSaveChips();
    rebuildInvested(newIsm);
    lastStatsPush=''; doPushStats();
    save.textContent='✓ Saved!';
    setTimeout(function(){save.textContent='✓ Save Settings';panel.style.display='none';btn.classList.remove('at-settings-btn-active');},1200);
  });
}

function attachScoreChip(abbr,key,color) {
  var chip=document.getElementById('at-chip-'+abbr); if(!chip) return;
  chip.addEventListener('click',function(e){
    e.stopPropagation();
    var valEl=document.getElementById('at-score-'+abbr),modEl=document.getElementById('at-mod-'+abbr);
    if(!valEl||valEl.tagName==='INPUT') return;
    var cur=parseInt(valEl.textContent)||10;
    var inp=document.createElement('input');
    inp.type='number';inp.min=1;inp.max=30;inp.value=cur;
    inp.style.cssText='width:34px;text-align:center;background:#071018;border:1px solid '+color+';color:#c8eeff;font-size:14px;font-weight:700;border-radius:3px;padding:1px 0;font-family:inherit;outline:none;';
    valEl.replaceWith(inp);inp.focus();inp.select();
    function commit(){
      var v=Math.max(1,Math.min(30,parseInt(inp.value)||10));
      var m=Math.floor((v-10)/2);
      var sp=document.createElement('span');sp.id='at-score-'+abbr;sp.textContent=v;
      inp.replaceWith(sp);
      if(modEl) modEl.textContent=(m>=0?'+':'')+m;
      var upd={};upd[key]=v;
      if(key==='investitureScore'){var ni=Math.max(0,m);upd.ismValue=ni;rebuildInvested(ni);var si2=document.getElementById('at-s-inv');if(si2) si2.value=v;}
      else{var si3=document.getElementById('at-s-san');if(si3) si3.value=v;}
      saveSettings(upd);
      refreshSaveChips();
      lastStatsPush='';doPushStats();
    }
    inp.addEventListener('blur',commit);
    inp.addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();commit();}if(e.key==='Escape'){inp.value=cur;commit();}});
  });
}

function setSlot(id,used){var e=document.getElementById(id);if(e) e.classList.toggle('at-used',!!used);}
function refreshUI(){
  setSlot('at-action',actionState.action);setSlot('at-bonus',actionState.bonusAction);setSlot('at-hasted-action',actionState.hastedAction);
  var hb=document.getElementById('at-haste-btn');if(hb) hb.classList.toggle('at-haste-active',!!actionState.hasted);
  var hw=document.getElementById('at-hasted-wrap');if(hw) hw.style.display=actionState.hasted?'block':'none';
  var r=settings.reactionCount||2;
  for(var i=0;i<r;i++){var rb=document.querySelector('.at-react[data-ridx="'+i+'"]');if(rb) rb.classList.toggle('at-used',!!(actionState.reactions&&actionState.reactions[i]));}
  var ism=pIsm();
  for(var j=0;j<ism;j++){var ib=document.querySelector('.at-invested[data-idx="'+j+'"]');if(ib) ib.classList.toggle('at-used',!!(actionState.investedActions&&actionState.investedActions[j]));}
  updateMovementDisplay();
}

function updateMovementDisplay(){
  var slider=document.getElementById('at-move-slider');
  var valEl=document.getElementById('at-move-value');
  var maxEl=document.getElementById('at-move-max');
  var used=actionState.movementUsed||0;
  var max=parseInt(slider&&slider.max||(domStats.speed||30));
  var pct=max>0?Math.min(100,(used/max)*100):0;
  if(valEl){valEl.textContent=used;valEl.style.color=used===0?'#9a8f72':used>=max?'#c43030':'#c9a84c';}
  if(maxEl) maxEl.textContent='/ '+max+' ft';
  if(slider){if(parseInt(slider.value)!==used) slider.value=used;slider.style.setProperty('--pct',pct+'%');}
}

function toggle(k){actionState[k]=!actionState[k];refreshUI();pushState();}
function toggleHaste(){actionState.hasted=!actionState.hasted;if(!actionState.hasted) actionState.hastedAction=false;refreshUI();pushState();}
function toggleReaction(i){if(!actionState.reactions) actionState.reactions=[];actionState.reactions[i]=!actionState.reactions[i];refreshUI();pushState();}
function toggleInvested(i){if(!actionState.investedActions) actionState.investedActions=[];actionState.investedActions[i]=!actionState.investedActions[i];refreshUI();pushState();}
function showFlash(){var e=document.getElementById('at-reset-flash');if(!e) return;e.classList.add('at-flash-show');setTimeout(function(){e.classList.remove('at-flash-show');},3500);}

function rebuildInvested(newIsm){
  actionState.investedActions=[];
  for(var i=0;i<newIsm;i++) actionState.investedActions.push(false);
  var row=document.getElementById('at-slots-row');if(!row) return;
  row.querySelectorAll('.at-invested,.at-divider').forEach(function(e){e.remove();});
  if(newIsm>0){
    var div=document.createElement('div');div.className='at-divider';row.appendChild(div);
    for(var j=0;j<newIsm;j++){
      var b=document.createElement('button');b.className='at-slot at-invested';b.dataset.idx=j;
      b.innerHTML='<span class="at-slot-icon">✦</span><span class="at-slot-label">INV '+(j+1)+'</span>';
      (function(idx){b.addEventListener('click',function(){toggleInvested(idx);});})(j);
      row.appendChild(b);
    }
  }
  pushState();
}

function loadNotes(){
  var key='c'+charId+'_notes';
  chromeSafe(function() {
    chrome.storage.local.get([key],function(data){
      var e=document.getElementById('at-notes-editor');
      if(e&&data[key]) e.innerHTML=data[key];
    });
  });
}

function attachNotesEvents(){
  var editor=document.getElementById('at-notes-editor');
  var toggle=document.getElementById('at-notes-toggle');
  var body=document.getElementById('at-notes-body');
  var fmts=document.querySelectorAll('.at-notes-fmt');
  if(!editor) return;
  window.addEventListener('beforeunload',function(e){if(notesSaveTimer){e.preventDefault();e.returnValue='';}});
  editor.addEventListener('input',function(){
    var html=editor.innerHTML;
    var obj={};obj['c'+charId+'_notes']=html;
    chromeSafe(function() { chrome.storage.local.set(obj); });
    clearTimeout(notesSaveTimer);
    notesSaveTimer=setTimeout(function(){pushNotes(html);notesSaveTimer=null;},1500);
  });
  for(var i=0;i<fmts.length;i++)(function(btn){btn.addEventListener('mousedown',function(e){e.preventDefault();document.execCommand(btn.dataset.cmd,false,null);editor.focus();});})(fmts[i]);
  var collapsed=false;
  if(toggle) toggle.addEventListener('click',function(){collapsed=!collapsed;body.style.display=collapsed?'none':'';toggle.textContent=collapsed?'▼':'▲';});
}

init();
