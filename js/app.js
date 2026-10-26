import * as api from './api.js';
import {
  MAIN_POSITIONS,
  analyzeWaivers,
  bestLineup,
  buildPlayerStats,
  findByeTeams,
  isOut,
  positionStrength,
  rankPositions,
  startablePositions,
  startingSlots,
  weekScore,
} from './analysis.js';

const DEFAULT_USERNAME = 'trdaniels90';
const FA_POOL_SIZE = 150;
const $ = (sel) => document.querySelector(sel);

const app = {
  username: '',
  nflState: null,
  user: null,
  leagues: [],
  leagueId: null,
  week: null,
  tab: 'team',
  league: null, // computed bundle for the selected league + week
  expandedTeam: null,
  waiver: { pos: 'ALL', hideOut: true, sort: 'gain' },
  rawCache: {}, // per-session cache of fetched league data
};

// ---------- small helpers ----------

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (n) => (n === null || n === undefined ? '–' : Number(n).toFixed(1));
const signed = (n) => (n > 0.05 ? `+${n.toFixed(1)}` : n < -0.05 ? n.toFixed(1) : '0.0');
const ordinal = (n) => n + (['th', 'st', 'nd', 'rd'][(n % 100 >> 3) ^ 1 && n % 10] || 'th');
const compact = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));

function store(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}
function recall(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function setStatus(msg, isError = false) {
  const el = $('#status');
  el.textContent = msg || '';
  el.hidden = !msg;
  el.classList.toggle('error', isError);
}

function playerImg(p) {
  if (p.pos === 'DEF') return `<img class="headshot" loading="lazy" alt="" src="https://sleepercdn.com/images/team_logos/nfl/${esc(p.id.toLowerCase())}.png" onerror="this.style.visibility='hidden'">`;
  return `<img class="headshot" loading="lazy" alt="" src="https://sleepercdn.com/content/nfl/players/thumb/${esc(p.id)}.jpg" onerror="this.style.visibility='hidden'">`;
}

function injuryBadge(p) {
  if (p.onBye) return '<span class="badge bye">BYE</span>';
  if (!p.injury) return '';
  const cls = isOut(p) ? 'out' : p.injury === 'Doubtful' ? 'doubtful' : 'questionable';
  return `<span class="badge ${cls}" title="${esc(p.injury)}">${esc(p.injury === 'Questionable' ? 'Q' : p.injury === 'Doubtful' ? 'D' : p.injury)}</span>`;
}

function playerCell(p) {
  return `<div class="player">${playerImg(p)}<div><div class="pname">${esc(p.name)} ${injuryBadge(p)}${
    p.trendRank && p.trendRank <= 25 ? '<span class="badge hot" title="Top 25 most-added on Sleeper in the last 24h">HOT</span>' : ''
  }</div><div class="pmeta"><span class="pos pos-${esc(p.pos)}">${esc(p.pos)}</span> ${esc(p.team || 'FA')}</div></div></div>`;
}

function rankClass(rank, n) {
  if (rank <= Math.ceil(n / 3)) return 'rank-good';
  if (rank > n - Math.ceil(n / 3)) return 'rank-bad';
  return 'rank-mid';
}

// ---------- data loading ----------

async function loadUser(username) {
  setStatus('Finding your leagues…');
  app.username = username;
  const [nflState, user] = await Promise.all([api.getState(), api.getUser(username)]);
  if (!user) throw new Error(`No Sleeper user named "${username}".`);
  app.nflState = nflState;
  app.user = user;
  app.leagues = await api.getLeagues(user.user_id, nflState.league_season || nflState.season);
  if (!app.leagues.length) throw new Error(`${username} has no NFL leagues for ${nflState.league_season}.`);
  store('sa.username', username);

  const saved = recall('sa.league');
  app.leagueId = app.leagues.some((l) => l.league_id === saved) ? saved : app.leagues[0].league_id;
  app.week = null;
  renderLeaguePicker();
  await loadLeague();
}

async function fetchLeagueRaw(leagueId) {
  if (app.rawCache[leagueId]) return app.rawCache[leagueId];
  const season = app.nflState.league_season || app.nflState.season;
  const currentWeek = app.nflState.season_type === 'regular' ? app.nflState.week : 0;

  setStatus('Loading league, rosters and players…');
  const [league, rosters, users, players, trendingAdds, trendingDrops] = await Promise.all([
    api.getLeague(leagueId),
    api.getRosters(leagueId),
    api.getLeagueUsers(leagueId),
    api.getPlayers(),
    api.getTrending('add'),
    api.getTrending('drop'),
  ]);

  setStatus('Loading weekly stats…');
  const weeks = Array.from({ length: currentWeek }, (_, i) => i + 1);
  const weeklyStats = await Promise.all(
    // Weeks before the current one are final, so they're safe to cache.
    weeks.map(async (week) => ({ week, stats: await api.getWeekStats(season, week, { cacheable: week < currentWeek }) })),
  );

  const raw = { season, currentWeek, league, rosters, users, players, trendingAdds, trendingDrops, weeklyStats, projections: {} };
  app.rawCache[leagueId] = raw;
  return raw;
}

async function projectionsFor(raw, week) {
  if (!(week in raw.projections)) raw.projections[week] = api.getWeekProjections(raw.season, week);
  return raw.projections[week];
}

// The week to set a lineup / make claims for. Sleeper's "current week" can
// still point at a week whose games are over, so step forward early in the week.
function defaultWeek(raw) {
  const w = Math.max(raw.currentWeek, 1);
  const current = raw.weeklyStats.find((s) => s.week === w);
  const started = current && Object.keys(current.stats).length > 0;
  const day = new Date().getDay(); // 2 = Tue, 3 = Wed
  return started && (day === 2 || day === 3) ? w + 1 : w;
}

async function loadLeague() {
  try {
    const raw = await fetchLeagueRaw(app.leagueId);
    if (!app.week) app.week = defaultWeek(raw);
    renderWeekPicker(raw);

    setStatus(`Loading week ${app.week} projections…`);
    const [projections, nextProjections] = await Promise.all([projectionsFor(raw, app.week), projectionsFor(raw, app.week + 1)]);
    app.league = computeLeague(raw, projections, nextProjections);
    setStatus('');
    render();
  } catch (err) {
    console.error(err);
    setStatus(err.message || 'Something went wrong loading the league.', true);
  }
}

function computeLeague(raw, projections, nextProjections) {
  const { league, rosters, users, players } = raw;
  const scoring = league.scoring_settings || {};
  const byeTeams = findByeTeams(projections, players);
  const nextByeTeams = findByeTeams(nextProjections, players);

  const stats = buildPlayerStats({
    players,
    weeklyStats: raw.weeklyStats,
    projections,
    nextProjections,
    scoring,
    byeTeams,
    nextByeTeams,
    trendingAdds: raw.trendingAdds,
    trendingDrops: raw.trendingDrops,
  });
  const lookup = (id) =>
    stats[id] || { id, name: `Player ${id}`, pos: '?', fp: [], team: '', injury: '', games: [], gp: 0, season: 0, avg: null, l3: null, proj: 0, nextProj: null, value: 0, onBye: false, trendAdd: 0, trendDrop: 0 };

  const slots = startingSlots(league.roster_positions || []);
  const usersById = new Map(users.map((u) => [u.user_id, u]));

  const teams = rosters.map((r) => {
    const owner = usersById.get(r.owner_id);
    const s = r.settings || {};
    const sidelined = new Set([...(r.reserve || []), ...(r.taxi || [])]);
    const all = (r.players || []).map(lookup);
    const active = all.filter((p) => !sidelined.has(p.id));
    return {
      rosterId: r.roster_id,
      ownerId: r.owner_id,
      coOwners: r.co_owners || [],
      name: owner?.metadata?.team_name || owner?.display_name || `Team ${r.roster_id}`,
      owner: owner?.display_name || 'Open slot',
      avatar: owner?.avatar,
      wins: s.wins || 0,
      losses: s.losses || 0,
      ties: s.ties || 0,
      pf: (s.fpts || 0) + (s.fpts_decimal || 0) / 100,
      pa: (s.fpts_against || 0) + (s.fpts_against_decimal || 0) / 100,
      streak: r.metadata?.streak || '',
      waiverPosition: s.waiver_position,
      faabLeft: (league.settings?.waiver_budget || 0) - (s.waiver_budget_used || 0),
      starters: r.starters || [],
      reserve: r.reserve || [],
      taxi: r.taxi || [],
      all,
      active,
      strength: positionStrength(active, slots),
    };
  });

  teams.sort((a, b) => b.wins - a.wins || a.losses - b.losses || b.pf - a.pf);
  teams.forEach((t, i) => (t.standing = i + 1));

  const positions = MAIN_POSITIONS.filter((pos) => slots.some((s) => s === pos));
  const ranks = rankPositions(teams, positions);
  teams.forEach((t) => (t.ranks = ranks.get(t.rosterId)));

  const me = teams.find((t) => t.ownerId === app.user.user_id || t.coOwners.includes(app.user.user_id));

  const rostered = new Set(rosters.flatMap((r) => r.players || []));
  const eligible = startablePositions(slots);
  const freeAgents = Object.values(stats).filter((p) => !rostered.has(p.id) && p.team && p.fp.some((pos) => eligible.has(pos)));
  // Analyse the most valuable free agents plus anyone trending league-wide.
  const pool = [...freeAgents].sort((a, b) => b.value - a.value).slice(0, FA_POOL_SIZE);
  const poolIds = new Set(pool.map((p) => p.id));
  for (const p of freeAgents) if (p.trendRank && !poolIds.has(p.id)) pool.push(p);

  const rosterSize = (league.roster_positions || []).filter((s) => s !== 'IR' && s !== 'TAXI').length;
  const waivers = me ? analyzeWaivers({ myRoster: me.active, freeAgents: pool, slots, rosterSize }) : null;

  return { league, slots, positions, teams, me, byeTeams, waivers, scoring };
}

// ---------- rendering ----------

function renderLeaguePicker() {
  const sel = $('#league');
  sel.innerHTML = app.leagues
    .map((l) => `<option value="${esc(l.league_id)}" ${l.league_id === app.leagueId ? 'selected' : ''}>${esc(l.name)} (${l.total_rosters} teams)</option>`)
    .join('');
  $('#pickers').hidden = false;
}

function renderWeekPicker(raw) {
  const last = Math.max(18, app.week);
  const opts = [];
  for (let w = 1; w <= last; w++) {
    opts.push(`<option value="${w}" ${w === app.week ? 'selected' : ''}>Week ${w}${w === raw.currentWeek ? ' (current)' : ''}</option>`);
  }
  $('#week').innerHTML = opts.join('');
}

function render() {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === app.tab));
  $('#tabs').hidden = !app.league;
  if (!app.league) return;
  const view = $('#view');
  if (app.tab === 'team') view.innerHTML = renderMyTeam();
  else if (app.tab === 'league') view.innerHTML = renderLeague();
  else view.innerHTML = renderWaivers();
}

function lineupRows(lineup, highlight) {
  return lineup
    .map(({ slot, player }) => {
      if (!player) return `<tr><td class="slot">${esc(slot)}</td><td colspan="4" class="muted">Empty – no eligible player</td></tr>`;
      return `<tr class="${highlight.has(player.id) ? 'changed' : ''}"><td class="slot">${esc(slot.replace('_', ' '))}</td><td>${playerCell(player)}</td><td class="num strong">${fmt(weekScore(player))}</td><td class="num">${fmt(player.l3)}</td><td class="num">${fmt(player.avg)}</td></tr>`;
    })
    .join('');
}

function renderMyTeam() {
  const L = app.league;
  const me = L.me;
  if (!me) return `<div class="card">You don't seem to own a team in this league.</div>`;

  const n = L.teams.length;
  const optimal = bestLineup(me.active, L.slots, weekScore);
  const byId = new Map(me.all.map((p) => [p.id, p]));
  const currentIds = me.starters.filter((id) => id && id !== '0');
  const current = currentIds.map((id) => byId.get(id)).filter(Boolean);
  const currentTotal = current.reduce((a, p) => a + weekScore(p), 0);
  const optimalIds = new Set(optimal.lineup.filter((s) => s.player).map((s) => s.player.id));
  const toStart = [...optimalIds].filter((id) => !currentIds.includes(id)).map((id) => byId.get(id));
  const toBench = current.filter((p) => !optimalIds.has(p.id));
  const empty = me.starters.filter((id) => !id || id === '0').length;

  const alerts = [];
  for (const p of current) {
    if (p.onBye) alerts.push(`<b>${esc(p.name)}</b> is on bye in week ${app.week}.`);
    else if (isOut(p)) alerts.push(`<b>${esc(p.name)}</b> is listed <b>${esc(p.injury)}</b>.`);
    else if (p.injury === 'Doubtful' || p.injury === 'Questionable') alerts.push(`<b>${esc(p.name)}</b> is <b>${esc(p.injury)}</b> – check news before kickoff.`);
  }
  if (empty) alerts.push(`You have <b>${empty}</b> empty starting slot${empty > 1 ? 's' : ''}.`);

  const waiverInfo =
    L.league.settings?.waiver_type === 2
      ? `<div class="stat"><div class="label">FAAB left</div><div class="value">$${me.faabLeft}</div></div>`
      : `<div class="stat"><div class="label">Waiver priority</div><div class="value">${me.waiverPosition ? ordinal(me.waiverPosition) : '–'}</div></div>`;

  const swaps = toStart.length
    ? `<div class="swaps"><div><h4>Start</h4>${toStart.map((p) => `<div class="swap in">${esc(p.name)} <span class="num">${fmt(weekScore(p))}</span></div>`).join('')}</div>
       <div><h4>Bench</h4>${toBench.map((p) => `<div class="swap out">${esc(p.name)} <span class="num">${fmt(weekScore(p))}</span></div>`).join('') || '<div class="muted">Fill empty slot</div>'}</div></div>`
    : `<p class="good-note">Your current Sleeper lineup is already the best by projection.</p>`;

  const benchPlayers = me.all.filter((p) => !optimalIds.has(p.id)).sort((a, b) => b.value - a.value);
  const reserveIds = new Set([...me.reserve, ...me.taxi]);

  return `
    <section class="stats-row">
      <div class="stat"><div class="label">${esc(me.name)}</div><div class="value">${me.wins}-${me.losses}${me.ties ? `-${me.ties}` : ''}</div><div class="sub">${ordinal(me.standing)} of ${n}</div></div>
      <div class="stat"><div class="label">Points for</div><div class="value">${me.pf.toFixed(1)}</div><div class="sub">${me.pa.toFixed(1)} against</div></div>
      ${waiverInfo}
      <div class="stat"><div class="label">Week ${app.week} projection</div><div class="value">${optimal.total.toFixed(1)}</div><div class="sub">best lineup · current ${currentTotal.toFixed(1)}</div></div>
    </section>

    ${alerts.length ? `<section class="card alerts"><h3>Heads up</h3><ul>${alerts.map((a) => `<li>${a}</li>`).join('')}</ul></section>` : ''}

    <div class="grid-2">
      <section class="card">
        <h3>Lineup advice · week ${app.week}</h3>
        ${swaps}
        <table class="table"><thead><tr><th>Slot</th><th>Best lineup</th><th class="num">Proj</th><th class="num">L3</th><th class="num">Avg</th></tr></thead>
        <tbody>${lineupRows(optimal.lineup, new Set(toStart.map((p) => p.id)))}</tbody></table>
        <p class="footnote">Your lineup in Sleeper is compared using week ${app.week} projections. Highlighted rows are changes.</p>
      </section>

      <section class="card">
        <h3>Position strength vs league</h3>
        <table class="table"><thead><tr><th>Pos</th><th class="num">Your starters</th><th class="num">League avg</th><th class="num">Rank</th></tr></thead><tbody>
        ${L.positions
          .map((pos) => {
            const leagueAvg = L.teams.reduce((a, t) => a + t.strength[pos], 0) / n;
            const r = me.ranks[pos];
            return `<tr><td><span class="pos pos-${pos}">${pos}</span></td><td class="num">${fmt(me.strength[pos])}</td><td class="num">${fmt(leagueAvg)}</td><td class="num"><span class="rank ${rankClass(r, n)}">${ordinal(r)}</span></td></tr>`;
          })
          .join('')}
        </tbody></table>
        <p class="footnote">Strength = combined rest-of-season value of the players who'd start at that position.</p>

        <h3>Bench &amp; reserve</h3>
        <table class="table"><thead><tr><th>Player</th><th class="num">Proj</th><th class="num">L3</th><th class="num">Value</th></tr></thead><tbody>
        ${benchPlayers
          .map((p) => `<tr><td>${playerCell(p)}${reserveIds.has(p.id) ? '<span class="muted small">IR/Taxi slot</span>' : ''}</td><td class="num">${fmt(weekScore(p))}</td><td class="num">${fmt(p.l3)}</td><td class="num">${fmt(p.value)}</td></tr>`)
          .join('')}
        </tbody></table>
      </section>
    </div>`;
}

function renderLeague() {
  const L = app.league;
  const n = L.teams.length;
  const me = L.me;

  const rows = L.teams
    .map((t) => {
      const isMe = me && t.rosterId === me.rosterId;
      const open = app.expandedTeam === t.rosterId;
      const rankCells = L.positions.map((pos) => `<td class="num"><span class="rank ${rankClass(t.ranks[pos], n)}" title="${fmt(t.strength[pos])} pts">${t.ranks[pos]}</span></td>`).join('');
      const main = `<tr class="team-row ${isMe ? 'me' : ''} ${open ? 'open' : ''}" data-roster="${t.rosterId}">
        <td class="num">${t.standing}</td>
        <td><div class="team">${t.avatar ? `<img class="avatar" loading="lazy" alt="" src="https://sleepercdn.com/avatars/thumbs/${esc(t.avatar)}">` : '<span class="avatar"></span>'}<div><div class="pname">${esc(t.name)}${isMe ? ' <span class="badge you">YOU</span>' : ''}</div><div class="pmeta">${esc(t.owner)}</div></div></div></td>
        <td class="num">${t.wins}-${t.losses}${t.ties ? `-${t.ties}` : ''}</td>
        <td class="num hide-sm">${t.pf.toFixed(1)}</td>
        <td class="num hide-sm">${t.pa.toFixed(1)}</td>
        <td class="num hide-sm">${esc(t.streak)}</td>
        ${rankCells}
      </tr>`;
      if (!open) return main;
      const players = [...t.all].sort((a, b) => b.value - a.value);
      return (
        main +
        `<tr class="expand"><td colspan="${6 + L.positions.length}"><div class="roster-grid">${players
          .map((p) => `<div class="roster-item">${playerCell(p)}<div class="num small">${fmt(p.value)}<div class="muted">value</div></div></div>`)
          .join('')}</div></td></tr>`
      );
    })
    .join('');

  return `
    <section class="card">
      <h3>Standings &amp; positional ranks</h3>
      <p class="footnote">Tap a team to see its roster. Position columns rank each team's starters (1 = strongest).</p>
      <div class="table-wrap"><table class="table standings"><thead><tr><th class="num">#</th><th>Team</th><th class="num">W-L</th><th class="num hide-sm">PF</th><th class="num hide-sm">PA</th><th class="num hide-sm">Strk</th>${L.positions.map((p) => `<th class="num">${p}</th>`).join('')}</tr></thead>
      <tbody>${rows}</tbody></table></div>
    </section>
    ${me ? renderTradePartners() : ''}`;
}

// Teams that are deep where I'm thin and thin where I'm deep.
function renderTradePartners() {
  const L = app.league;
  const me = L.me;
  const n = L.teams.length;
  const strong = (t) => L.positions.filter((p) => !['K', 'DEF'].includes(p) && t.ranks[p] <= Math.ceil(n / 3));
  const weak = (t) => L.positions.filter((p) => !['K', 'DEF'].includes(p) && t.ranks[p] > n - Math.ceil(n / 3));
  const myStrong = strong(me);
  const myWeak = weak(me);

  const partners = L.teams
    .filter((t) => t.rosterId !== me.rosterId)
    .map((t) => ({ t, theyGive: strong(t).filter((p) => myWeak.includes(p)), theyNeed: weak(t).filter((p) => myStrong.includes(p)) }))
    .filter((x) => x.theyGive.length && x.theyNeed.length);

  return `<section class="card">
    <h3>Trade partners</h3>
    ${
      partners.length
        ? `<ul class="partners">${partners
            .map((x) => `<li><b>${esc(x.t.name)}</b> is deep at <b>${x.theyGive.join(', ')}</b> and thin at <b>${x.theyNeed.join(', ')}</b>, which is where you're deep.</li>`)
            .join('')}</ul>`
        : `<p class="muted">No obvious matches right now. You're ${myWeak.length ? `thin at ${myWeak.join(', ')}` : 'not clearly thin anywhere'}${myStrong.length ? ` and deep at ${myStrong.join(', ')}` : ''}.</p>`
    }
  </section>`;
}

function renderWaivers() {
  const L = app.league;
  if (!L.me || !L.waivers) return `<div class="card">You don't seem to own a team in this league.</div>`;
  const { results, dropCosts, needsDrop } = L.waivers;
  const n = L.teams.length;
  const w = app.waiver;

  const weakSpots = L.positions.filter((p) => L.me.ranks[p] > n / 2).map((p) => `${p} (${ordinal(L.me.ranks[p])})`);
  const sorters = {
    gain: (a, b) => b.gain - a.gain || b.weekGain - a.weekGain || b.margin - a.margin,
    week: (a, b) => b.weekGain - a.weekGain || b.gain - a.gain,
    trend: (a, b) => b.player.trendAdd - a.player.trendAdd,
    proj: (a, b) => (b.player.proj ?? -1) - (a.player.proj ?? -1),
    l3: (a, b) => (b.player.l3 ?? -1) - (a.player.l3 ?? -1),
    value: (a, b) => b.player.value - a.player.value,
  };

  const list = results
    .filter((r) => w.pos === 'ALL' || r.player.fp.includes(w.pos))
    .filter((r) => !w.hideOut || !isOut(r.player))
    .sort(sorters[w.sort])
    .slice(0, 50);

  const rows = list
    .map(
      (r) => `<tr>
      <td>${playerCell(r.player)}</td>
      <td class="num"><span class="gain ${r.gain > 0.05 ? 'up' : ''}">${signed(r.gain)}</span></td>
      <td class="num"><span class="gain ${r.weekGain > 0.05 ? 'up' : ''}">${signed(r.weekGain)}</span></td>
      <td class="num hide-sm">${fmt(r.player.proj)}</td>
      <td class="num hide-sm">${fmt(r.player.l3)}</td>
      <td class="num hide-sm">${fmt(r.player.avg)}</td>
      <td class="num">${r.player.trendAdd ? compact(r.player.trendAdd) : '–'}</td>
      <td class="hide-sm">${r.drop && r.gain > 0.05 ? esc(r.drop.name) : needsDrop ? '<span class="muted">–</span>' : '<span class="muted">open spot</span>'}</td>
    </tr>`,
    )
    .join('');

  const posChips = ['ALL', ...L.positions].map((p) => `<button class="chip ${w.pos === p ? 'active' : ''}" data-pos="${p}">${p === 'ALL' ? 'All' : p}</button>`).join('');

  return `
    <div class="grid-2 waiver-top">
      <section class="card">
        <h3>Your weak spots</h3>
        <p>${weakSpots.length ? weakSpots.join(' · ') : 'None – you rank in the top half at every position.'}</p>
        ${L.byeTeams.size ? `<p class="muted small">On bye week ${app.week}: ${[...L.byeTeams].sort().join(', ')}</p>` : ''}
      </section>
      <section class="card">
        <h3>Easiest drops</h3>
        <ol class="drops">${dropCosts
          .slice(0, 3)
          .map((d) => `<li>${esc(d.player.name)} <span class="muted">${esc(d.player.pos)} · lineup loss ${fmt(d.cost)}</span></li>`)
          .join('')}</ol>
      </section>
    </div>

    <section class="card">
      <h3>Best available free agents</h3>
      <div class="controls">
        <div class="chips">${posChips}</div>
        <label class="check"><input type="checkbox" id="hideOut" ${w.hideOut ? 'checked' : ''}> Hide Out/IR</label>
        <label>Sort <select id="sort">
          ${[
            ['gain', 'Season upgrade'],
            ['week', `Week ${app.week} upgrade`],
            ['trend', 'Most added (24h)'],
            ['proj', 'Projection'],
            ['l3', 'Last 3 games'],
            ['value', 'Overall value'],
          ]
            .map(([v, label]) => `<option value="${v}" ${w.sort === v ? 'selected' : ''}>${label}</option>`)
            .join('')}
        </select></label>
      </div>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Player</th><th class="num" title="Points per week your best lineup gains, rest of season">Season +</th><th class="num" title="Points your week ${app.week} lineup gains">Wk ${app.week} +</th><th class="num hide-sm">Proj</th><th class="num hide-sm">L3</th><th class="num hide-sm">Avg</th><th class="num" title="Adds across all Sleeper leagues, last 24h">Adds</th><th class="hide-sm">Drop</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="8" class="muted">No free agents match.</td></tr>'}</tbody>
      </table></div>
      <p class="footnote"><b>Season +</b> is how many points per week your best lineup would improve if you add the player (and drop the suggested player when your roster is full). A 0.0 means they wouldn't start for you, which can still be fine for a bench stash. <b>Adds</b> is how many Sleeper users added them in the last 24 hours.</p>
    </section>`;
}

// ---------- events ----------

function bind() {
  $('#user-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('#username').value.trim();
    if (!name) return;
    app.rawCache = {};
    app.league = null;
    render();
    loadUser(name).catch((err) => setStatus(err.message, true));
  });

  $('#league').addEventListener('change', (e) => {
    app.leagueId = e.target.value;
    store('sa.league', app.leagueId);
    app.week = null;
    app.expandedTeam = null;
    loadLeague();
  });

  $('#week').addEventListener('change', (e) => {
    app.week = Number(e.target.value);
    loadLeague();
  });

  $('#refresh').addEventListener('click', () => {
    delete app.rawCache[app.leagueId];
    loadLeague();
  });

  $('#tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    app.tab = tab.dataset.tab;
    store('sa.tab', app.tab);
    render();
  });

  $('#view').addEventListener('click', (e) => {
    const row = e.target.closest('.team-row');
    if (row) {
      const id = Number(row.dataset.roster);
      app.expandedTeam = app.expandedTeam === id ? null : id;
      render();
      return;
    }
    const chip = e.target.closest('.chip');
    if (chip) {
      app.waiver.pos = chip.dataset.pos;
      render();
    }
  });

  $('#view').addEventListener('change', (e) => {
    if (e.target.id === 'hideOut') app.waiver.hideOut = e.target.checked;
    if (e.target.id === 'sort') app.waiver.sort = e.target.value;
    render();
  });
}

function init() {
  bind();
  const params = new URLSearchParams(location.search);
  const username = params.get('user') || recall('sa.username') || DEFAULT_USERNAME;
  app.tab = recall('sa.tab') || 'team';
  $('#username').value = username;
  loadUser(username).catch((err) => setStatus(err.message, true));
}

init();
