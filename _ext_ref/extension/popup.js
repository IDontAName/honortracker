// popup.js v17 — per-character settings keyed by DDB character ID from the active tab URL

function getCharId(cb) {
  chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
    if (!tabs || !tabs[0]) { cb(null); return; }
    var m = (tabs[0].url || '').match(/\/characters\/(\d+)/);
    cb(m ? m[1] : null);
  });
}

function key(cid, field) { return 'c' + cid + '_' + field; }

function calcMod(score) { return Math.floor((parseInt(score)||10) - 10) / 2 | 0; }
function fmtMod(n) { return (n >= 0 ? '+' : '') + n; }

function updatePreviews() {
  var san = parseInt(document.getElementById('sanityScore').value)||10;
  var inv = parseInt(document.getElementById('investitureScore').value)||10;
  document.getElementById('sanityMod').textContent = fmtMod(calcMod(san));
  document.getElementById('investitureMod').textContent = fmtMod(calcMod(inv));
}

document.getElementById('sanityScore').addEventListener('input', updatePreviews);
document.getElementById('investitureScore').addEventListener('input', updatePreviews);

var currentCharId = null;

getCharId(function(cid) {
  currentCharId = cid;
  var cidDisplay = document.getElementById('char-id-display');
  if (cidDisplay) cidDisplay.textContent = cid ? 'Character #' + cid : 'No character sheet open';

  if (!cid) {
    // Grey out the form if no character sheet is open
    document.getElementById('saveBtn').disabled = true;
    document.getElementById('saveBtn').textContent = 'Open a character sheet first';
    return;
  }

  var fields = ['sessionId','reactionCount','sanityScore','investitureScore','sanProf','invProf'];
  var keys = fields.map(function(f){ return key(cid, f); });
  chrome.storage.local.get(keys, function(data) {
    var get = function(f) { return data[key(cid, f)]; };
    if (get('sessionId') !== undefined)       document.getElementById('sessionId').value = get('sessionId');
    if (get('reactionCount') !== undefined)   document.getElementById('reactionCount').value = get('reactionCount');
    if (get('sanityScore') !== undefined)     document.getElementById('sanityScore').value = get('sanityScore');
    if (get('investitureScore') !== undefined) document.getElementById('investitureScore').value = get('investitureScore');
    if (get('sanProf') !== undefined)  document.getElementById('sanProf').checked = !!get('sanProf');
    if (get('invProf') !== undefined)  document.getElementById('invProf').checked = !!get('invProf');
    updatePreviews();
  });
});

document.getElementById('saveBtn').addEventListener('click', function() {
  if (!currentCharId) return;
  var cid = currentCharId;
  var invScore = parseInt(document.getElementById('investitureScore').value)||10;
  var invMod = calcMod(invScore);

  var toSave = {};
  toSave[key(cid,'sessionId')]        = document.getElementById('sessionId').value.trim() || 'campaign-1';
  toSave[key(cid,'reactionCount')]    = Math.max(1, Math.min(6, parseInt(document.getElementById('reactionCount').value)||2));
  toSave[key(cid,'sanityScore')]      = Math.max(1, Math.min(30, parseInt(document.getElementById('sanityScore').value)||10));
  toSave[key(cid,'investitureScore')] = Math.max(1, Math.min(30, invScore));
  toSave[key(cid,'sanProf')]          = document.getElementById('sanProf').checked;
  toSave[key(cid,'invProf')]          = document.getElementById('invProf').checked;
  toSave[key(cid,'ismValue')]         = Math.max(0, invMod);

  chrome.storage.local.set(toSave, function() {
    var btn = document.getElementById('saveBtn');
    var msg = document.getElementById('savedMsg');
    btn.classList.add('saved');
    msg.classList.add('show');
    setTimeout(function() { btn.classList.remove('saved'); msg.classList.remove('show'); }, 2500);
  });
});
