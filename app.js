// ===== Sleeper Live Draft Room =====
const API = 'https://api.sleeper.app/v1';
const AVATAR = (id, thumb=true) => id
  ? `https://sleepercdn.com/avatars/${thumb ? 'thumbs/' : ''}${id}`
  : '';

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- State ----
const state = {
  user: null,
  season: null,
  league: null,
  draft: null,
  draftUsers: [],          // sleeper users in league
  rosterIdToUser: {},
  slotToUser: {},          // slot -> user object
  picks: [],
  knownPickIds: new Set(),
  pollTimer: null,
  countdownTimer: null,
  muted: false,
  lastPick: null,
  bootedAt: 0,
  // Dynasty value / roster rank
  rosters: [],
  superflex: true,
  ktc: null,               // normalizedName -> { sf, oqb, rank }
  playerIndex: null,       // player_id -> { name, pos, team }
  rosterValue: {},         // roster_id -> total value
  rosterRank: {},          // roster_id -> rank (1 = best)
  rosterCount: 0,
};

// ---- Boot / page router ----
// index.html holds the setup screen (#setup); draft.html holds the room (#room).
window.addEventListener('DOMContentLoaded', () => {
  if ($('setup')) initSetupPage();
  if ($('room')) initDraftPage();
});

function initSetupPage() {
  const sel = $('season');
  const cur = new Date().getFullYear();
  for (let y = cur; y >= cur - 5; y--) {
    const opt = document.createElement('option');
    opt.value = y; opt.textContent = y;
    sel.appendChild(opt);
  }
  sel.value = cur;
  sel.addEventListener('change', () => loadLeagues());

  $('loadUser').addEventListener('click', loadUser);
  $('username').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadUser(); });
  $('demoBtn').addEventListener('click', () => { window.location.href = 'draft.html?demo=1'; });
}

function initDraftPage() {
  $('back').addEventListener('click', () => { window.location.href = 'index.html'; });
  $('muteBtn').addEventListener('click', toggleMute);
  document.addEventListener('click', primeAudio, { once: true });
  loadHighlights(); // rookie highlight clips (fire and forget)
  loadYTApi();      // persistent reel player

  // Video lightbox close handlers
  $('videoModalClose').addEventListener('click', closeVideoModal);
  $('videoModalBackdrop').addEventListener('click', closeVideoModal);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeVideoModal(); });
  // One-tap sound: unmute the live player (this click authorizes audio for the rest of the session).
  $('videoModalUnmute').addEventListener('click', () => {
    try { ytPlayer.unMute(); ytPlayer.setVolume(100); ytPlayer.playVideo(); } catch (e) {}
    ytActivated = true;
    $('videoModalUnmute').hidden = true;
  });

  const params = new URLSearchParams(window.location.search);
  if (params.get('demo') === '1') {
    startDemo();
    return;
  }
  const leagueId = params.get('league_id');
  const draftId = params.get('draft_id');
  if (leagueId && draftId) {
    bootLiveDraft(leagueId, draftId);
  } else {
    $('statusText').textContent = 'no draft selected';
    $('statusDot').className = 'status-dot done';
    $('leagueName').textContent = 'No draft selected';
    $('draftMeta').textContent = 'Go back and pick a league + draft.';
  }
}

let audioPrimed = false;
function primeAudio() {
  if (audioPrimed) return;
  const a = $('chime');
  // Unlock the audio element with a MUTED play/pause so nothing is audible.
  a.muted = true;
  const p = a.play();
  if (p && p.then) {
    p.then(() => { a.pause(); a.currentTime = 0; a.muted = false; audioPrimed = true; })
     .catch(() => { a.muted = false; });
  }
  blessPlayer(); // this click also unlocks the reel player for sound
}

// ---- API helpers ----
async function jget(path) {
  const r = await fetch(`${API}${path}`);
  if (!r.ok) throw new Error(`${r.status} on ${path}`);
  return r.json();
}

// Fetch a JSON file served alongside the app (not the Sleeper API).
async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} on ${url}`);
  return r.json();
}

// Accepts a full YouTube URL, an /embed/ URL, or a bare 11-char video id.
function youTubeId(s) {
  if (!s) return '';
  const m = String(s).match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|watch\?v=|v\/|shorts\/))([A-Za-z0-9_-]{11})/);
  if (m) return m[1];
  const bare = String(s).trim();
  return /^[A-Za-z0-9_-]{11}$/.test(bare) ? bare : '';
}

// Load rookie highlight clips: { "Player Name": "<url or id>" } -> normalizedName -> videoId
async function loadHighlights() {
  if (state.highlights) return;
  try {
    const raw = await fetchJSON(`highlights.json?t=${Date.now()}`);
    const map = {};
    for (const k in raw) {
      const id = youTubeId(raw[k]);
      if (id) map[normName(k)] = id;
    }
    state.highlights = map;
  } catch (e) {
    state.highlights = {};
  }
}

function showError(msg) {
  const e = $('setupError');
  e.textContent = msg;
  e.hidden = false;
}
function clearError() { $('setupError').hidden = true; }

// ---- Setup flow ----
async function loadUser() {
  clearError();
  const name = $('username').value.trim();
  if (!name) return;
  $('leagueList').innerHTML = '';
  $('draftList').innerHTML = '';
  try {
    const user = await jget(`/user/${encodeURIComponent(name)}`);
    if (!user || !user.user_id) { showError('User not found.'); return; }
    state.user = user;
    $('seasonRow').hidden = false;
    await loadLeagues();
  } catch (err) {
    showError(`Could not load user: ${err.message}`);
  }
}

async function loadLeagues() {
  $('draftList').innerHTML = '';
  $('leagueList').innerHTML = '<div class="hint">Loading leagues…</div>';
  const season = $('season').value;
  state.season = season;
  try {
    const leagues = await jget(`/user/${state.user.user_id}/leagues/nfl/${season}`);
    const list = $('leagueList');
    list.innerHTML = '';
    list.classList.remove('collapsed');
    if (!leagues.length) {
      list.innerHTML = '<div class="hint">No leagues for this season.</div>';
      return;
    }
    leagues.forEach(lg => {
      const div = document.createElement('div');
      div.className = 'league-item';
      div.innerHTML = `
        <img src="${AVATAR(lg.avatar)}" alt="" onerror="this.style.visibility='hidden'" />
        <div class="meta">
          <div class="name">${escapeHtml(lg.name)}</div>
          <div class="sub">${lg.total_rosters} teams · ${lg.status.replace(/_/g,' ')} · ${lg.season}</div>
        </div>
        <div class="status ${lg.status}">${lg.status.replace(/_/g,' ')}</div>
      `;
      div.dataset.leagueId = lg.league_id;
      div.addEventListener('click', () => pickLeague(lg, div));
      list.appendChild(div);
    });
  } catch (err) {
    $('leagueList').innerHTML = '';
    showError(`Could not load leagues: ${err.message}`);
  }
}

async function pickLeague(lg, el) {
  const leagueList = $('leagueList');

  // If the list is already collapsed and you click the selected league, re-expand to switch.
  if (leagueList.classList.contains('collapsed') && el && el.classList.contains('selected')) {
    leagueList.classList.remove('collapsed');
    $('draftList').innerHTML = '';
    return;
  }

  state.league = lg;
  // Collapse the league list down to just the chosen league so the draft picker is in view.
  leagueList.querySelectorAll('.league-item').forEach(n => n.classList.remove('selected'));
  if (el) el.classList.add('selected');
  leagueList.classList.add('collapsed');

  $('draftList').innerHTML = '<div class="hint">Loading drafts…</div>';
  try {
    const drafts = await jget(`/league/${lg.league_id}/drafts`);
    const list = $('draftList');
    list.innerHTML = '';

    // Header: label + "change league" affordance to reopen the full list.
    const head = document.createElement('div');
    head.className = 'draft-head';
    head.innerHTML = `<span>Select a draft</span>`;
    const changeBtn = document.createElement('button');
    changeBtn.type = 'button';
    changeBtn.className = 'change-league';
    changeBtn.textContent = '↺ change league';
    changeBtn.addEventListener('click', () => {
      leagueList.classList.remove('collapsed');
      leagueList.querySelectorAll('.league-item').forEach(n => n.classList.remove('selected'));
      list.innerHTML = '';
    });
    head.appendChild(changeBtn);
    list.appendChild(head);

    if (!drafts.length) {
      const empty = document.createElement('div');
      empty.className = 'hint';
      empty.textContent = 'No drafts in this league.';
      list.appendChild(empty);
      list.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      return;
    }
    drafts.forEach(d => {
      const div = document.createElement('div');
      div.className = 'draft-item';
      const dt = d.start_time ? new Date(d.start_time).toLocaleString() : 'TBD';
      div.innerHTML = `
        <div class="meta">
          <div class="name">${escapeHtml(d.metadata?.name || `${cap(d.type)} Draft`)}</div>
          <div class="sub">${d.settings.teams} teams · ${d.settings.rounds} rounds · ${d.metadata?.scoring_type || ''} · starts ${dt}</div>
        </div>
        <div class="status ${d.status}">${d.status.replace(/_/g,' ')}</div>
      `;
      div.addEventListener('click', () => {
        window.location.href = `draft.html?league_id=${encodeURIComponent(lg.league_id)}&draft_id=${encodeURIComponent(d.draft_id)}`;
      });
      list.appendChild(div);
    });
    list.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (err) {
    showError(`Could not load drafts: ${err.message}`);
  }
}

// ---- Draft room (live) ----
// Called on draft.html with the IDs from the URL. Re-fetches everything fresh.
async function bootLiveDraft(leagueId, draftId) {
  state.picks = [];
  state.knownPickIds = new Set();
  state.lastPick = null;
  state.bootedAt = Date.now();
  state.demoMode = false;

  $('statusText').textContent = 'loading…';

  let draft, league;
  try {
    [draft, league] = await Promise.all([
      jget(`/draft/${draftId}`),
      jget(`/league/${leagueId}`),
    ]);
  } catch (e) {
    $('leagueName').textContent = 'Failed to load draft';
    $('draftMeta').textContent = e.message;
    $('statusText').textContent = 'error';
    $('statusDot').className = 'status-dot done';
    return;
  }

  state.draft = draft;
  state.league = league;

  $('leagueName').textContent = league.name;
  $('draftMeta').textContent = `${cap(draft.type)} · ${draft.settings.teams} teams · ${draft.settings.rounds} rounds · ${draft.metadata?.scoring_type?.toUpperCase() || ''}`;

  try {
    const users = await jget(`/league/${leagueId}/users`);
    state.draftUsers = users;
    const rosters = await jget(`/league/${leagueId}/rosters`).catch(() => []);
    state.rosters = rosters;
    state.superflex = (league.roster_positions || []).includes('SUPER_FLEX');
    state.rosterIdToUser = {};
    rosters.forEach(r => {
      const u = users.find(x => x.user_id === r.owner_id);
      if (u) state.rosterIdToUser[r.roster_id] = u;
    });

    // slot -> user
    state.slotToUser = {};
    if (draft.draft_order) {
      for (const [uid, slot] of Object.entries(draft.draft_order)) {
        state.slotToUser[slot] = users.find(u => u.user_id === uid);
      }
    } else if (draft.slot_to_roster_id) {
      for (const [slot, rid] of Object.entries(draft.slot_to_roster_id)) {
        state.slotToUser[slot] = state.rosterIdToUser[rid];
      }
    }

    // slot -> original roster id (the roster that owns that draft slot before any trades)
    state.slotToRosterId = {};
    if (draft.slot_to_roster_id) {
      for (const [slot, rid] of Object.entries(draft.slot_to_roster_id)) {
        state.slotToRosterId[slot] = rid;
      }
    } else if (draft.draft_order) {
      const userToRoster = {};
      rosters.forEach(r => { userToRoster[r.owner_id] = r.roster_id; });
      for (const [uid, slot] of Object.entries(draft.draft_order)) {
        state.slotToRosterId[slot] = userToRoster[uid];
      }
    }

    // Traded draft picks: a pick's CURRENT owner can differ from its slot's original owner.
    // Each entry: { round, roster_id (original slot owner), owner_id (current owner) }.
    state.tradedPickOwner = {};
    const traded = await jget(`/draft/${draftId}/traded_picks`).catch(() => []);
    (traded || []).forEach(tp => {
      state.tradedPickOwner[`${tp.round}:${tp.roster_id}`] = tp.owner_id;
    });
  } catch (e) {
    console.warn('users/rosters fetch failed', e);
  }

  // Previous-season draft class — powers the recent-box flashback.
  state.prevSeason = null;
  state.prevTeams = null;
  state.prevPicksByUser = {};
  try {
    const prevId = league.previous_league_id;
    if (prevId && prevId !== '0') {
      const prevDrafts = await jget(`/league/${prevId}/drafts`).catch(() => []);
      const prevDraft = (prevDrafts || []).find(d => d.status === 'complete') || (prevDrafts || [])[0];
      if (prevDraft) {
        state.prevSeason = prevDraft.season;
        state.prevTeams = prevDraft.settings?.teams || null;
        const prevPicks = await jget(`/draft/${prevDraft.draft_id}/picks`).catch(() => []);
        (prevPicks || []).forEach(p => {
          if (!p.picked_by) return;
          if (!state.prevPicksByUser[p.picked_by]) state.prevPicksByUser[p.picked_by] = [];
          state.prevPicksByUser[p.picked_by].push(p);
        });
      }
    }
  } catch (e) { console.warn('prev-season load failed', e); }

  // Initial picks load — mark as "known" without firing chime
  await loadPicks(true);
  buildBoard();
  renderBoard();
  startPolling();
  updateClock();
  state.recentView = 'prev'; // open on the flashback so round 1 leads with 2025 classes
  renderRecent();
  startRecentToggle();
  loadTeamValues(); // async: KTC value + roster rank badge (refreshes clock when ready)
}

async function loadPicks(initial=false) {
  try {
    const picks = await jget(`/draft/${state.draft.draft_id}/picks`);
    const newPicks = picks.filter(p => !state.knownPickIds.has(p.pick_no));

    if (!initial && newPicks.length) {
      // Fire chime on the latest new pick only
      const latest = newPicks[newPicks.length - 1];
      fireChime(latest);
      revealPick(latest);
    }

    picks.forEach(p => state.knownPickIds.add(p.pick_no));
    state.picks = picks;

    if (picks.length) state.lastPick = picks[picks.length - 1];

    renderRecent();
    renderBoard();
    updateClock();
    renderAvailable(); // drop drafted rookies off the best-available board
    setStatus();
  } catch (err) {
    console.warn('poll failed', err);
    $('statusText').textContent = 'reconnecting…';
    $('statusDot').className = 'status-dot idle';
  }
}

function startPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  const intervalMs = 3500; // ~17 polls/min
  state.pollTimer = setInterval(() => loadPicks(false), intervalMs);
}

// ---- Chime / reveal ----
function fireChime(pick) {
  if (state.muted) return;
  const a = $('chime');
  try {
    a.currentTime = 0;
    a.play().catch(err => console.warn('audio play blocked', err));
  } catch (e) { /* noop */ }
  const flash = $('flash');
  flash.classList.remove('fire');
  // restart animation
  void flash.offsetWidth;
  flash.classList.add('fire');
}

function revealPick(pick) {
  $('onClockBlock').hidden = true;
  const lp = $('lastPickBlock');
  lp.hidden = false;
  $('lpPickNo').textContent = ordinal(pick.pick_no);
  const user = ownerUserForPick(pick);
  const teamName = teamLabel(user);
  $('lpTeam').textContent = teamName;
  $('lpAvatar').src = AVATAR(user?.avatar) || '';
  $('lpAvatar').style.visibility = user?.avatar ? 'visible' : 'hidden';
  const lpTrade = $('lpTrade');
  if (lpTrade) lpTrade.hidden = !pickWasTraded(pick);

  const meta = pick.metadata || {};
  $('playerPos').textContent = meta.position || '—';
  $('playerFirst').textContent = (meta.first_name || '').toUpperCase();
  $('playerLast').textContent = (meta.last_name || '').toUpperCase();
  $('playerMeta').textContent = [meta.team || '', meta.injury_status, meta.status].filter(Boolean).join(' · ');

  $('roundChip').textContent = `RND ${pick.round}`;
  $('pickChip').textContent = `PICK ${pick.pick_no}`;

  // one-time shine sweep across the player card
  const pc = $('playerCard');
  pc.classList.remove('shine');
  void pc.offsetWidth;
  pc.classList.add('shine');

  // Rookie highlight reel, if we have a clip for this player — rolled ~10s after the pick.
  const vid = state.highlights && state.highlights[normName(`${meta.first_name || ''} ${meta.last_name || ''}`)];
  const hasVid = !!vid;
  const playerName = `${meta.first_name || ''} ${meta.last_name || ''}`.trim();
  clearTimeout(state._highlightStart);
  closeVideoModal(); // clear any reel still up from the previous pick

  if (hasVid) {
    // Announce the pick first, then roll the reel ~5s later in the big lightbox. Plays with sound
    // automatically if the player's been blessed by any earlier click; otherwise a one-tap 🔊 enables it.
    state._highlightStart = setTimeout(() => { openVideoModal(playerName, vid, false); }, 5000);
  }

  // Hold the reveal long enough for the 5s lead-in plus the reel.
  clearTimeout(state._revealTimeout);
  state._revealTimeout = setTimeout(() => {
    clearTimeout(state._highlightStart);
    closeVideoModal();
    $('lastPickBlock').hidden = true;
    $('onClockBlock').hidden = false;
    updateClock();
  }, hasVid ? 27000 : 6500);
}

// ---- Persistent reel player (one YouTube player, blessed for sound by the first user click) ----
let ytPlayer = null, ytReady = false, ytActivated = false;
const BLESS_VID = 'G-8iLrN3Mg4'; // cued placeholder so the first gesture can grant sound

function loadYTApi() {
  if (window.YT && window.YT.Player) { window.onYouTubeIframeAPIReady(); return; }
  if (document.getElementById('yt-iframe-api')) return;
  const s = document.createElement('script');
  s.id = 'yt-iframe-api';
  s.src = 'https://www.youtube.com/iframe_api';
  document.head.appendChild(s);
}
window.onYouTubeIframeAPIReady = function () {
  if (ytPlayer || !$('ytplayer')) return;
  ytPlayer = new YT.Player('ytplayer', {
    videoId: BLESS_VID,
    playerVars: { autoplay: 0, controls: 1, rel: 0, playsinline: 1, modestbranding: 1 },
    events: { onReady: () => { ytReady = true; try { ytPlayer.mute(); } catch (e) {} } },
  });
};

// On the first real user gesture, briefly play→unmute the player so later reels can autoplay with sound.
function blessPlayer() {
  if (ytActivated || !ytReady || !ytPlayer) return;
  if (navigator.userActivation && !navigator.userActivation.isActive) return; // only counts during a real gesture
  try {
    ytPlayer.mute();
    ytPlayer.playVideo();
    ytPlayer.unMute();
    ytPlayer.setVolume(10); // low so the warm-up blip is inaudible; reels set it back to 100
    clearTimeout(state._blessTimer);
    state._blessTimer = setTimeout(() => {
      try { ytPlayer.pauseVideo(); ytPlayer.seekTo(0, true); ytPlayer.setVolume(100); } catch (e) {}
    }, 140);
    ytActivated = true;
  } catch (e) { /* noop */ }
}

// ---- Video lightbox (pick reveal + click a best-available player) ----
// gesture=true when opened from a click (sound allowed); the reel reuses one blessed player so
// auto-reveals also play with sound once the player has been activated by any earlier click.
function openVideoModal(name, vid, gesture) {
  if (!ytReady || !ytPlayer) return; // player still initializing — skip gracefully
  clearTimeout(state._blessTimer); // don't let a pending warm-up pause this real reel
  state._modalName = name;
  state._modalVid = vid;
  $('videoModalTitle').textContent = name;
  const wantSound = !!(gesture || ytActivated);
  try {
    if (wantSound) { ytPlayer.unMute(); ytPlayer.setVolume(100); ytActivated = true; }
    else { ytPlayer.mute(); }
    ytPlayer.loadVideoById(vid); // autoplays
  } catch (e) { /* noop */ }
  const um = $('videoModalUnmute');
  if (um) um.hidden = wantSound; // offer one-tap sound only when it started muted
  $('videoModal').classList.add('open');
}
function closeVideoModal() {
  try { if (ytPlayer && ytPlayer.stopVideo) ytPlayer.stopVideo(); } catch (e) {}
  const m = $('videoModal');
  if (m) m.classList.remove('open');
  const um = $('videoModalUnmute');
  if (um) um.hidden = true;
}

// ---- Recent picks ----
// Router: the recent box shows either live picks, or the on-the-clock owner's prior-season class.
// Falls back to the flashback whenever there are no live picks to show (e.g. start of the draft).
// Guarded by a content signature so idle timer ticks don't re-render (which would re-flash the animation).
function renderRecent(force = false) {
  const noLive = !state.picks || state.picks.length === 0;
  const view = (state.prevSeason && (state.recentView === 'prev' || noLive)) ? 'prev' : 'live';

  let sig;
  if (view === 'prev') {
    const info = nextPickInfo();
    const user = info ? ownerUserForUpcoming(info.round, info.slot) : null;
    const rid = info ? ownerRosterForPick(info.round, info.slot)?.rosterId : null;
    sig = `prev|${user?.user_id || ''}|${state.rosterValue[rid] ?? ''}|${state.prevSeason || ''}`;
  } else {
    sig = `live|${state.picks.length}|${state.picks[state.picks.length - 1]?.pick_no ?? ''}`;
  }
  if (!force && sig === state._recentSig) return; // nothing changed — don't re-flash
  state._recentSig = sig;

  if (view === 'prev') renderPrevClass();
  else renderRecentLive();
}

function renderRecentLive() {
  const head = $('recentHead');
  if (head) head.textContent = 'RECENT PICKS';
  const list = $('recentList');
  list.innerHTML = '';
  const items = state.picks.slice(-20).reverse();
  if (!items.length) {
    list.innerHTML = '<li class="recent-empty">No picks in yet.</li>';
    return;
  }
  items.forEach((p, i) => {
    const li = document.createElement('li');
    li.className = 'recent-item' + (i === 0 ? ' new' : '');
    const user = ownerUserForPick(p);
    const m = p.metadata || {};
    li.innerHTML = `
      <span class="pick-no">${p.round}.${String(p.pick_no - (p.round-1)*state.draft.settings.teams).padStart(2,'0')}</span>
      <img src="${AVATAR(user?.avatar)}" alt="" onerror="this.style.visibility='hidden'" />
      <div>
        <div class="player">${escapeHtml(m.first_name || '')} ${escapeHtml(m.last_name || '')}</div>
        <div style="color:var(--muted); font-size:11px;">${escapeHtml(teamLabel(user))}${pickWasTraded(p) ? ' · <span style="color:#7fd4ff">via trade</span>' : ''}</div>
      </div>
      <span class="pos">${escapeHtml(m.position || '')}${m.team ? ' · ' + escapeHtml(m.team) : ''}</span>
    `;
    list.appendChild(li);
  });
}

// Flashback view: the on-the-clock owner's draft class from the previous season.
function renderPrevClass() {
  const list = $('recentList');
  const head = $('recentHead');
  const info = nextPickInfo();
  const user = info ? ownerUserForUpcoming(info.round, info.slot) : null;
  const uid = user?.user_id;
  if (!uid) { renderRecentLive(); return; }
  const picks = state.prevPicksByUser[uid] || [];
  const rid = ownerRosterForPick(info.round, info.slot)?.rosterId;
  let valueStr = '';
  if (rid != null && state.rosterValue[rid] != null) {
    valueStr = ` · <span class="hb-ktc">KTC ${fmtVal(state.rosterValue[rid])} · #${state.rosterRank[rid]}</span>`;
  }
  if (head) head.innerHTML = `<span class="flashback">${escapeHtml(short(teamLabel(user)))}</span> · ${escapeHtml(state.prevSeason || 'PREV')} CLASS${valueStr}`;
  list.innerHTML = '';
  if (!picks.length) {
    list.innerHTML = `<li class="recent-empty">No ${escapeHtml(state.prevSeason || 'prior')} draft class found for this manager.</li>`;
    return;
  }
  const teamsPrev = state.prevTeams || state.draft.settings.teams;
  picks.slice(0, 14).forEach(p => {
    const li = document.createElement('li');
    li.className = 'recent-item prev';
    const m = p.metadata || {};
    li.innerHTML = `
      <span class="pick-no">${p.round}.${String(p.pick_no - (p.round-1)*teamsPrev).padStart(2,'0')}</span>
      <img src="${AVATAR(user?.avatar)}" alt="" onerror="this.style.visibility='hidden'" />
      <div>
        <div class="player">${escapeHtml(m.first_name || '')} ${escapeHtml(m.last_name || '')}</div>
        <div style="color:var(--muted); font-size:11px;">${escapeHtml(m.team || '')}${m.team && m.position ? ' · ' : ''}${escapeHtml(m.position || '')}</div>
      </div>
      <span class="pos">${escapeHtml(m.position || '')}${m.team ? ' · ' + escapeHtml(m.team) : ''}</span>
    `;
    list.appendChild(li);
  });
}

// Flip the recent box between live picks and the prior-season flashback on a timer.
// The live 2026 round only enters the rotation once the first selection has been made;
// until then we hold on the on-the-clock manager's 2025 class.
function startRecentToggle() {
  clearInterval(state.recentToggleTimer);
  if (!state.prevSeason) { state.recentView = 'live'; return; } // demo / no prior league
  state.recentToggleTimer = setInterval(() => {
    const hasPicks = state.picks.length > 0; // at least one 2026 selection on the board
    if (!hasPicks) state.recentView = 'prev';
    else state.recentView = state.recentView === 'live' ? 'prev' : 'live';
    renderRecent();
  }, 8000);
}

// Round/slot/owner of the upcoming pick (shared by the clock and the flashback).
function nextPickInfo() {
  if (!state.draft) return null;
  const teams = state.draft.settings.teams;
  const rounds = state.draft.settings.rounds;
  const nextPickNo = state.picks.length + 1;
  if (nextPickNo > teams * rounds) return null;
  const round = Math.ceil(nextPickNo / teams);
  const idxInRound = nextPickNo - (round - 1) * teams;
  const slot = state.draft.type === 'snake' && round % 2 === 0 ? teams - idxInRound + 1 : idxInRound;
  return { nextPickNo, round, idxInRound, slot, teams, rounds };
}

// ---- Board ----
function buildBoard() {
  const teams = state.draft.settings.teams;
  const rounds = state.draft.settings.rounds;
  const board = $('board');
  board.innerHTML = '';
  // sticky header row
  const header = document.createElement('div');
  header.className = 'board-row board-header-row';
  header.style.gridTemplateColumns = `40px repeat(${teams}, minmax(84px, 1fr))`;
  header.innerHTML = `<div class="board-cell" style="background:transparent;border:none"></div>` +
    Array.from({length: teams}, (_, i) => {
      const slot = i + 1;
      const u = state.slotToUser[slot];
      const name = teamLabel(u);
      return `<div class="board-cell" title="${escapeHtml(name)}">${escapeHtml(short(name))}</div>`;
    }).join('');
  board.appendChild(header);

  for (let r = 1; r <= rounds; r++) {
    const row = document.createElement('div');
    row.className = 'board-row';
    row.style.gridTemplateColumns = `40px repeat(${teams}, minmax(84px, 1fr))`;
    let cells = `<div class="board-cell" style="background:transparent;border:none;color:var(--muted);font-family:'Bebas Neue';display:flex;align-items:center;justify-content:center">R${r}</div>`;
    for (let s = 1; s <= teams; s++) {
      const slot = visualSlotForRound(r, s, teams, state.draft.type);
      const pickNo = (r-1) * teams + s;
      cells += `<div class="board-cell empty" data-pick="${pickNo}" data-slot="${slot}"></div>`;
    }
    row.innerHTML = cells;
    board.appendChild(row);
  }
}

// For snake drafts, even rounds reverse, but display layout is by draft_slot column (1..N), not by chronological pick order
function visualSlotForRound(round, columnIdx, teams, type) {
  if (type === 'snake' && round % 2 === 0) {
    return teams - columnIdx + 1;
  }
  return columnIdx;
}

function renderBoard() {
  const teams = state.draft.settings.teams;
  const cells = document.querySelectorAll('.board-cell[data-pick]');
  cells.forEach(c => {
    c.className = 'board-cell empty';
    c.innerHTML = '';
  });

  state.picks.forEach(p => {
    const c = document.querySelector(`.board-cell[data-pick="${p.pick_no}"]`);
    if (!c) return;
    const m = p.metadata || {};
    c.className = `board-cell pos-${m.position || ''}`;
    c.innerHTML = `
      <div class="cell-no">${p.round}.${String(p.pick_no - (p.round-1)*teams).padStart(2,'0')}</div>
      <div class="cell-name">${escapeHtml((m.first_name||'')[0] || '')}. ${escapeHtml(m.last_name || '')}</div>
      <div class="cell-pos">${escapeHtml(m.position || '')}${m.team ? ' · ' + escapeHtml(m.team) : ''}</div>
    `;
  });

  // mark next pick
  const nextPickNo = state.picks.length + 1;
  const nextCell = document.querySelector(`.board-cell[data-pick="${nextPickNo}"]`);
  if (nextCell && state.draft.status === 'drafting') nextCell.classList.add('onclock');

  // legend
  $('boardLegend').textContent = `${state.picks.length} / ${state.draft.settings.teams * state.draft.settings.rounds} picks`;
}

// ---- On the clock ----
function updateClock() {
  if (state.draft.status === 'complete') {
    $('statusText').textContent = 'draft complete';
    $('statusDot').className = 'status-dot done';
    $('roundChip').textContent = `RND ${state.draft.settings.rounds}`;
    $('pickChip').textContent = `FINAL`;
    if (!state.picks.length) return;
    return;
  }

  const teams = state.draft.settings.teams;
  const rounds = state.draft.settings.rounds;
  const nextPickNo = state.picks.length + 1;
  if (nextPickNo > teams * rounds) return;
  const round = Math.ceil(nextPickNo / teams);
  const idxInRound = nextPickNo - (round - 1) * teams;
  const slot = state.draft.type === 'snake' && round % 2 === 0
    ? teams - idxInRound + 1
    : idxInRound;

  $('roundChip').textContent = `RND ${round}`;
  $('pickChip').textContent = `PICK ${nextPickNo}`;

  const info = ownerRosterForPick(round, slot);
  const user = ownerUserForUpcoming(round, slot);
  const name = teamLabel(user);
  $('onClockName').textContent = name;
  const scoring = state.draft.metadata?.scoring_type?.toUpperCase() || '';
  if (info && info.traded) {
    const origUser = state.rosterIdToUser[info.originalRosterId] || state.slotToUser[slot];
    $('onClockSub').innerHTML = `<span style="color:#7fd4ff">via trade</span> · from ${escapeHtml(short(teamLabel(origUser)))} · slot ${slot}`;
  } else {
    $('onClockSub').textContent = `slot ${slot}${scoring ? ' · ' + scoring : ''}`;
  }
  $('onClockAvatar').src = AVATAR(user?.avatar) || '';
  $('onClockAvatar').style.visibility = user?.avatar ? 'visible' : 'hidden';

  // KTC value + roster rank badge for the team on the clock
  renderValueBadge('onClockValue', info && info.rosterId);

  // countdown
  if (state.countdownTimer) clearInterval(state.countdownTimer);
  const pickTimer = state.draft.settings.pick_timer || 0;
  const lastPicked = state.draft.last_picked || state.bootedAt;
  state.countdownTimer = setInterval(() => {
    if (!pickTimer) { $('countdown').textContent = '— : —'; return; }
    const elapsed = (Date.now() - lastPicked) / 1000;
    const remain = Math.max(0, pickTimer - elapsed);
    const m = Math.floor(remain / 60);
    const s = Math.floor(remain % 60);
    $('countdown').textContent = `${m}:${String(s).padStart(2,'0')}`;
  }, 250);
}

function setStatus() {
  const s = state.draft.status;
  if (s === 'drafting') { $('statusText').textContent = 'LIVE'; $('statusDot').className = 'status-dot live'; }
  else if (s === 'pre_draft') { $('statusText').textContent = 'PRE-DRAFT'; $('statusDot').className = 'status-dot idle'; }
  else { $('statusText').textContent = s.replace(/_/g, ' '); $('statusDot').className = 'status-dot done'; }
}

// ---- Helpers ----
function userForSlot(slot) { return state.slotToUser[slot]; }

// Resolve the CURRENT owner roster of an upcoming pick at (round, slot), accounting for traded picks.
function ownerRosterForPick(round, slot) {
  const originalRid = state.slotToRosterId ? state.slotToRosterId[slot] : null;
  if (originalRid == null) return null;
  const tradedTo = state.tradedPickOwner && state.tradedPickOwner[`${round}:${originalRid}`];
  const currentRid = (tradedTo != null) ? tradedTo : originalRid;
  return { rosterId: currentRid, originalRosterId: originalRid, traded: Number(currentRid) !== Number(originalRid) };
}
// User on the clock for an upcoming pick (trade-aware).
function ownerUserForUpcoming(round, slot) {
  const info = ownerRosterForPick(round, slot);
  if (info && state.rosterIdToUser[info.rosterId]) return state.rosterIdToUser[info.rosterId];
  return state.slotToUser[slot] || null;
}
// For a COMPLETED pick, Sleeper tells us exactly who drafted (picked_by) and where the player landed (roster_id).
// Prefer those over the slot owner so traded picks credit the correct team.
function ownerUserForPick(p) {
  if (p.picked_by) {
    const u = (state.draftUsers || []).find(x => x.user_id === p.picked_by);
    if (u) return u;
  }
  if (p.roster_id != null && state.rosterIdToUser[p.roster_id]) return state.rosterIdToUser[p.roster_id];
  return state.slotToUser[p.draft_slot] || null;
}
// Did a completed pick land on a roster other than its slot's original owner? (i.e. it was traded)
function pickWasTraded(p) {
  const slotRid = state.slotToRosterId ? state.slotToRosterId[p.draft_slot] : null;
  return slotRid != null && p.roster_id != null && Number(slotRid) !== Number(p.roster_id);
}
function teamLabel(user) {
  if (!user) return 'Open Slot';
  return user.metadata?.team_name || user.display_name || user.username || 'Manager';
}
function short(s) {
  if (!s) return '';
  if (s.length <= 10) return s;
  return s.split(' ').map(w => w[0]).slice(0,4).join('').toUpperCase();
}
function ordinal(n) {
  const s = ['th','st','nd','rd'];
  const v = n % 100;
  return n + (s[(v-20)%10] || s[v] || s[0]);
}
function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }
function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ---- Dynasty value / roster rank (KeepTradeCut) ----
// Normalize a player name so Sleeper names and KTC names match (drops suffixes + punctuation).
function normName(n) {
  if (!n) return '';
  let toks = String(n).toLowerCase().trim().split(/\s+/);
  while (toks.length && ['jr','sr','ii','iii','iv','v'].includes(toks[toks.length-1].replace(/\./g,''))) toks.pop();
  return toks.join('').replace(/[^a-z0-9]/g, '');
}

async function loadKTC() {
  if (state.ktc) return;
  const data = await fetchJSON('ktc_values.json');
  const map = {};
  (data.players || []).forEach(p => {
    map[normName(p.name)] = { sf: p.sf_value, oqb: p.oqb_value, rank: p.sf_rank, pos: p.position };
  });
  state.ktc = map;
  state.ktcDate = data.date || null;
}

// Build (and cache) a player_id -> {name,pos,team} index from Sleeper's player dump.
async function loadPlayerIndex() {
  if (state.playerIndex) return;
  const today = new Date().toISOString().slice(0, 10);
  const cacheKey = 'nflPlayerIdx_v2';
  try {
    const cached = JSON.parse(localStorage.getItem(cacheKey) || 'null');
    if (cached && cached.date === today && cached.idx) { state.playerIndex = cached.idx; return; }
  } catch (e) { /* ignore */ }

  const players = await jget('/players/nfl');
  const idx = {};
  for (const pid in players) {
    const pl = players[pid];
    const name = pl.full_name || `${pl.first_name || ''} ${pl.last_name || ''}`.trim();
    if (!name) continue;
    idx[pid] = { name, pos: pl.position, team: pl.team, exp: pl.years_exp };
  }
  state.playerIndex = idx;
  try { localStorage.setItem(cacheKey, JSON.stringify({ date: today, idx })); } catch (e) { /* quota */ }
}

function valueForPlayerId(pid) {
  const p = state.playerIndex && state.playerIndex[pid];
  if (!p || p.pos === 'DEF' || p.pos === 'K') return 0;
  const k = state.ktc && state.ktc[normName(p.name)];
  if (!k) return 0;
  return state.superflex ? (k.sf || 0) : (k.oqb || 0);
}

// Sum each roster's value, then rank teams (1 = highest).
function computeRosterValues() {
  if (!state.ktc || !state.playerIndex) return;
  const totals = {};
  state.rosters.forEach(r => {
    let tot = 0;
    (r.players || []).forEach(pid => { tot += valueForPlayerId(pid); });
    totals[r.roster_id] = tot;
  });
  state.rosterValue = totals;
  state.rosterCount = state.rosters.length;
  const ordered = Object.keys(totals).sort((a, b) => totals[b] - totals[a]);
  const rank = {};
  ordered.forEach((rid, i) => { rank[rid] = i + 1; });
  state.rosterRank = rank;
}

// Fire-and-forget: load values, compute ranks, refresh the clock badge.
async function loadTeamValues() {
  try {
    await Promise.all([loadKTC(), loadPlayerIndex(), loadHighlights()]);
    computeRosterValues();
    buildRookiePool();
    updateClock();
    renderRecent(); // surface the KTC value in the flashback header now that it's loaded
    renderAvailable();
  } catch (e) {
    console.warn('team values unavailable', e);
  }
}

// Build the rookie pool: years_exp 0 skill players that carry a KTC value, sorted by value.
function buildRookiePool() {
  if (!state.ktc || !state.playerIndex) return;
  const pool = [];
  for (const pid in state.playerIndex) {
    const p = state.playerIndex[pid];
    if (p.exp !== 0) continue;
    if (!['QB', 'RB', 'WR', 'TE'].includes(p.pos)) continue;
    const k = state.ktc[normName(p.name)];
    if (!k) continue;
    pool.push({ pid, name: p.name, pos: p.pos, team: p.team, value: state.superflex ? k.sf : k.oqb, ktcRank: k.rank });
  }
  pool.sort((a, b) => b.value - a.value);
  state.rookiePool = pool;
}

// Render the best-available rookies, excluding anyone drafted or already rostered.
function renderAvailable() {
  const list = $('availableList');
  if (!list) return;
  const countEl = $('availCount');
  if (!state.rookiePool || !state.rookiePool.length) {
    list.innerHTML = '<li class="avail-empty">Best-available loads with KTC values…</li>';
    if (countEl) countEl.textContent = '';
    return;
  }
  const takenIds = new Set();
  const takenNames = new Set();
  state.picks.forEach(p => {
    if (p.player_id) takenIds.add(String(p.player_id));
    takenNames.add(normName(`${p.metadata?.first_name || ''} ${p.metadata?.last_name || ''}`));
  });
  (state.rosters || []).forEach(r => (r.players || []).forEach(pid => takenIds.add(String(pid))));

  const avail = state.rookiePool.filter(r => !takenIds.has(String(r.pid)) && !takenNames.has(normName(r.name)));
  if (countEl) countEl.textContent = `${avail.length} left`;
  list.innerHTML = '';
  avail.forEach((r, i) => {
    const clip = state.highlights && state.highlights[normName(r.name)];
    const li = document.createElement('li');
    li.className = `avail-item pos-${r.pos}` + (clip ? ' has-clip' : '');
    li.innerHTML = `
      <span class="avail-rank">${i + 1}</span>
      <div class="avail-main">
        <div class="avail-name">${escapeHtml(r.name)}${clip ? '<span class="avail-play" title="Watch highlights">▶</span>' : ''}</div>
        <div class="avail-sub">${escapeHtml(r.pos)}${r.team ? ' · ' + escapeHtml(r.team) : ''}</div>
      </div>
      <span class="avail-val">${fmtVal(r.value)}</span>
    `;
    if (clip) li.addEventListener('click', () => openVideoModal(r.name, clip, true));
    list.appendChild(li);
  });
}

// "48,210" formatting
function fmtVal(n) { return (n || 0).toLocaleString('en-US'); }

// Render a "KTC 96,499 · #1 / 12" badge into an element for a given roster.
function renderValueBadge(elId, rosterId) {
  const el = $(elId);
  if (!el) return;
  if (rosterId == null || !state.rosterCount || state.rosterValue[rosterId] == null) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }
  const val = state.rosterValue[rosterId];
  const rank = state.rosterRank[rosterId];
  const medal = rank === 1 ? ' top' : (rank > state.rosterCount - 3 ? ' low' : '');
  el.hidden = false;
  el.className = `value-badge${medal}`;
  el.innerHTML = `<span class="vb-ktc">KTC</span> <span class="vb-num">${fmtVal(val)}</span>` +
    `<span class="vb-rank">#${rank} <span class="vb-of">/ ${state.rosterCount}</span></span>`;
}

function toggleMute() {
  state.muted = !state.muted;
  $('muteBtn').textContent = state.muted ? '🔇' : '🔊';
}

// ============ DEMO MODE ============
const DEMO_MANAGERS = [
  { display_name: 'Couch GM',         team_name: 'Recliner Royalty' },
  { display_name: 'Waiver Warrior',   team_name: 'FAAB Bandits' },
  { display_name: 'Trade Bait',       team_name: 'Sharks of Sunday' },
  { display_name: 'Handcuff King',    team_name: 'Backup Bandits' },
  { display_name: 'Zero RB Truther',  team_name: 'WR Empire' },
  { display_name: 'Sleeper Hunter',   team_name: 'Late Round Lottery' },
  { display_name: 'Boom or Bust',     team_name: 'Volatility Inc.' },
  { display_name: 'Stat Stuffer',     team_name: 'Garbage Time GOATs' },
  { display_name: 'Process Trust',    team_name: 'Long Game Legion' },
  { display_name: 'Vibes Only',       team_name: 'Gut Feel FC' },
  { display_name: 'Analytics Andy',   team_name: 'EPA Apostles' },
  { display_name: 'Reigning Champ',   team_name: 'Defending Dynasty' },
];

const DEMO_PLAYERS = [
  { first:'Christian', last:'McCaffrey',  pos:'RB',  team:'SF'  },
  { first:'CeeDee',    last:'Lamb',       pos:'WR',  team:'DAL' },
  { first:'Tyreek',    last:'Hill',       pos:'WR',  team:'MIA' },
  { first:'Bijan',     last:'Robinson',   pos:'RB',  team:'ATL' },
  { first:'Breece',    last:'Hall',       pos:'RB',  team:'NYJ' },
  { first:'Ja\'Marr',  last:'Chase',      pos:'WR',  team:'CIN' },
  { first:'Justin',    last:'Jefferson',  pos:'WR',  team:'MIN' },
  { first:'Amon-Ra',   last:'St. Brown',  pos:'WR',  team:'DET' },
  { first:'Jahmyr',    last:'Gibbs',      pos:'RB',  team:'DET' },
  { first:'Jonathan',  last:'Taylor',     pos:'RB',  team:'IND' },
  { first:'Garrett',   last:'Wilson',     pos:'WR',  team:'NYJ' },
  { first:'A.J.',      last:'Brown',      pos:'WR',  team:'PHI' },
  { first:'Saquon',    last:'Barkley',    pos:'RB',  team:'PHI' },
  { first:'Puka',      last:'Nacua',      pos:'WR',  team:'LAR' },
  { first:'Drake',     last:'London',     pos:'WR',  team:'ATL' },
  { first:'De\'Von',   last:'Achane',     pos:'RB',  team:'MIA' },
  { first:'Kyren',     last:'Williams',   pos:'RB',  team:'LAR' },
  { first:'Nico',      last:'Collins',    pos:'WR',  team:'HOU' },
  { first:'Sam',       last:'LaPorta',    pos:'TE',  team:'DET' },
  { first:'Travis',    last:'Etienne',    pos:'RB',  team:'JAX' },
  { first:'Davante',   last:'Adams',      pos:'WR',  team:'LV'  },
  { first:'Josh',      last:'Allen',      pos:'QB',  team:'BUF' },
  { first:'Patrick',   last:'Mahomes',    pos:'QB',  team:'KC'  },
  { first:'Jalen',     last:'Hurts',      pos:'QB',  team:'PHI' },
  { first:'Lamar',     last:'Jackson',    pos:'QB',  team:'BAL' },
  { first:'Travis',    last:'Kelce',      pos:'TE',  team:'KC'  },
  { first:'Mark',      last:'Andrews',    pos:'TE',  team:'BAL' },
  { first:'Stefon',    last:'Diggs',      pos:'WR',  team:'HOU' },
  { first:'DK',        last:'Metcalf',    pos:'WR',  team:'SEA' },
  { first:'DeVonta',   last:'Smith',      pos:'WR',  team:'PHI' },
  { first:'Mike',      last:'Evans',      pos:'WR',  team:'TB'  },
  { first:'Chris',     last:'Olave',      pos:'WR',  team:'NO'  },
  { first:'Tee',       last:'Higgins',    pos:'WR',  team:'CIN' },
  { first:'Cooper',    last:'Kupp',       pos:'WR',  team:'LAR' },
  { first:'Derrick',   last:'Henry',      pos:'RB',  team:'BAL' },
  { first:'Josh',      last:'Jacobs',     pos:'RB',  team:'GB'  },
  { first:'Isiah',     last:'Pacheco',    pos:'RB',  team:'KC'  },
  { first:'Rachaad',   last:'White',      pos:'RB',  team:'TB'  },
  { first:'Aaron',     last:'Jones',      pos:'RB',  team:'MIN' },
  { first:'James',     last:'Cook',       pos:'RB',  team:'BUF' },
  { first:'David',     last:'Montgomery', pos:'RB',  team:'DET' },
  { first:'Joe',       last:'Mixon',      pos:'RB',  team:'HOU' },
  { first:'Kenneth',   last:'Walker',     pos:'RB',  team:'SEA' },
  { first:'Marvin',    last:'Harrison Jr.', pos:'WR', team:'ARI' },
  { first:'Malik',     last:'Nabers',     pos:'WR',  team:'NYG' },
  { first:'Rome',      last:'Odunze',     pos:'WR',  team:'CHI' },
  { first:'Caleb',     last:'Williams',   pos:'QB',  team:'CHI' },
  { first:'C.J.',      last:'Stroud',     pos:'QB',  team:'HOU' },
  { first:'Jayden',    last:'Daniels',    pos:'QB',  team:'WAS' },
  { first:'Brock',     last:'Purdy',      pos:'QB',  team:'SF'  },
  { first:'Trey',      last:'McBride',    pos:'TE',  team:'ARI' },
  { first:'Kyle',      last:'Pitts',      pos:'TE',  team:'ATL' },
  { first:'Brandon',   last:'Aiyuk',      pos:'WR',  team:'SF'  },
  { first:'Deebo',     last:'Samuel',     pos:'WR',  team:'SF'  },
  { first:'Calvin',    last:'Ridley',     pos:'WR',  team:'TEN' },
  { first:'Jaylen',    last:'Waddle',     pos:'WR',  team:'MIA' },
  { first:'Terry',     last:'McLaurin',   pos:'WR',  team:'WAS' },
  { first:'Diontae',   last:'Johnson',    pos:'WR',  team:'CAR' },
  { first:'Keenan',    last:'Allen',      pos:'WR',  team:'CHI' },
  { first:'Amari',     last:'Cooper',     pos:'WR',  team:'CLE' },
  { first:'D.J.',      last:'Moore',      pos:'WR',  team:'CHI' },
  { first:'Christian', last:'Kirk',       pos:'WR',  team:'JAX' },
  { first:'George',    last:'Pickens',    pos:'WR',  team:'PIT' },
  { first:'Tank',      last:'Dell',       pos:'WR',  team:'HOU' },
  { first:'Zay',       last:'Flowers',    pos:'WR',  team:'BAL' },
  { first:'Najee',     last:'Harris',     pos:'RB',  team:'PIT' },
  { first:'Tony',      last:'Pollard',    pos:'RB',  team:'TEN' },
  { first:'Alvin',     last:'Kamara',     pos:'RB',  team:'NO'  },
  { first:'Rhamondre', last:'Stevenson',  pos:'RB',  team:'NE'  },
  { first:'D\'Andre',  last:'Swift',      pos:'RB',  team:'CHI' },
  { first:'Javonte',   last:'Williams',   pos:'RB',  team:'DEN' },
  { first:'Dak',       last:'Prescott',   pos:'QB',  team:'DAL' },
  { first:'Joe',       last:'Burrow',     pos:'QB',  team:'CIN' },
  { first:'Anthony',   last:'Richardson', pos:'QB',  team:'IND' },
  { first:'Justin',    last:'Herbert',    pos:'QB',  team:'LAC' },
  { first:'George',    last:'Kittle',     pos:'TE',  team:'SF'  },
  { first:'Dallas',    last:'Goedert',    pos:'TE',  team:'PHI' },
  { first:'Evan',      last:'Engram',     pos:'TE',  team:'JAX' },
  { first:'David',     last:'Njoku',      pos:'TE',  team:'CLE' },
  { first:'Jake',      last:'Ferguson',   pos:'TE',  team:'DAL' },
  { first:'Justin',    last:'Tucker',     pos:'K',   team:'BAL' },
  { first:'Harrison',  last:'Butker',     pos:'K',   team:'KC'  },
  { first:'Dallas',    last:'Cowboys',    pos:'DEF', team:'DAL' },
  { first:'San Francisco', last:'49ers',  pos:'DEF', team:'SF'  },
];

function startDemo() {
  const teams = 12;
  const rounds = 6;
  const totalPicks = teams * rounds;

  // Synthesize a league
  state.league = {
    league_id: 'demo',
    name: 'PRIMETIME DEMO LEAGUE',
    total_rosters: teams,
    status: 'drafting',
    avatar: null,
  };

  // Synthesize a draft
  state.draft = {
    draft_id: 'demo',
    type: 'snake',
    status: 'drafting',
    season: String(new Date().getFullYear()),
    settings: { teams, rounds, pick_timer: 90 },
    metadata: { name: 'Primetime Demo', scoring_type: 'ppr' },
    draft_order: null,
    slot_to_roster_id: Object.fromEntries(Array.from({length: teams}, (_, i) => [String(i+1), i+1])),
    last_picked: Date.now(),
  };

  // Synthesize users + slot mapping
  state.draftUsers = DEMO_MANAGERS.map((m, i) => ({
    user_id: `demo_${i+1}`,
    username: m.display_name.toLowerCase().replace(/\s+/g,''),
    display_name: m.display_name,
    avatar: null,
    metadata: { team_name: m.team_name },
  }));
  state.rosterIdToUser = {};
  state.slotToUser = {};
  state.draftUsers.forEach((u, i) => {
    state.rosterIdToUser[i+1] = u;
    state.slotToUser[i+1] = u;
  });
  // No trades in the demo: 1:1 slot→roster, empty traded map (keeps trade-aware code happy).
  state.slotToRosterId = Object.fromEntries(Array.from({length: teams}, (_, i) => [String(i+1), i+1]));
  state.tradedPickOwner = {};

  // Shuffle a player pool so each demo run is different
  const pool = [...DEMO_PLAYERS].sort(() => Math.random() - 0.5);
  // Lead the demo with a highlighted rookie so the embedded reel is easy to preview.
  pool.unshift({ first: 'Jeremiyah', last: 'Love', pos: 'RB', team: 'ARI' });

  // Reset picks state
  state.picks = [];
  state.knownPickIds = new Set();
  state.lastPick = null;
  state.bootedAt = Date.now();
  state.demoMode = true;
  // No prior-season flashback in the demo.
  state.prevSeason = null;
  state.prevPicksByUser = {};
  state.recentView = 'live';
  clearInterval(state.recentToggleTimer);

  // Reveal the room (on draft.html it's already visible; guard for safety)
  if ($('setup')) $('setup').hidden = true;
  if ($('room')) $('room').hidden = false;
  $('leagueName').textContent = state.league.name;
  $('draftMeta').textContent = `DEMO · SNAKE · ${teams} TEAMS · ${rounds} ROUNDS · PPR`;

  buildBoard();
  renderRecent();
  renderBoard();
  updateClock();
  setStatus();

  // Make sure chime is unlocked — the demoBtn click counts as user gesture
  primeAudio();

  // Stop any prior timers so nothing keeps firing in the background
  if (state.pollTimer) clearInterval(state.pollTimer);
  if (state.demoTimer) clearTimeout(state.demoTimer);

  const scheduleNext = (first) => {
    if (!state.demoMode) return;
    if (state.picks.length >= totalPicks) {
      state.draft.status = 'complete';
      setStatus();
      return;
    }
    // First pick lands quickly; then ~13s between picks so each reel gets the 5s lead-in + airtime.
    const delay = first ? 1400 : (12000 + Math.random() * 2000); // ~12–14s between picks
    state.demoTimer = setTimeout(() => {
      pushDemoPick(pool, teams, rounds);
      scheduleNext(false);
    }, delay);
  };
  scheduleNext(true);
}

function pushDemoPick(pool, teams, rounds) {
  if (!pool.length) return;
  const pickNo = state.picks.length + 1;
  const round = Math.ceil(pickNo / teams);
  const idxInRound = pickNo - (round - 1) * teams;
  const slot = round % 2 === 0 ? teams - idxInRound + 1 : idxInRound;
  const rosterId = slot;

  // Bias position pick by round: skill positions early, K/DEF/QB depth late
  let chosenIdx = 0;
  if (round <= 4) {
    chosenIdx = pool.findIndex(p => ['RB','WR','TE'].includes(p.pos));
    if (chosenIdx < 0) chosenIdx = 0;
  } else {
    chosenIdx = 0;
  }
  const p = pool.splice(chosenIdx, 1)[0];

  const pick = {
    pick_no: pickNo,
    round,
    draft_slot: slot,
    roster_id: String(rosterId),
    picked_by: state.slotToUser[slot]?.user_id || '',
    player_id: `demo_${pickNo}`,
    metadata: {
      first_name: p.first,
      last_name: p.last,
      position: p.pos,
      team: p.team,
      status: 'Active',
      sport: 'nfl',
      injury_status: '',
    },
    is_keeper: null,
    draft_id: 'demo',
  };

  state.picks.push(pick);
  state.knownPickIds.add(pick.pick_no);
  state.lastPick = pick;
  state.draft.last_picked = Date.now();

  fireChime(pick);
  revealPick(pick);
  renderRecent();
  renderBoard();
}
