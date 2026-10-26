// Thin wrapper around Sleeper's public, read-only API (https://docs.sleeper.com).
// No auth is needed; every endpoint is CORS-enabled so the browser can call it directly.

const BASE = 'https://api.sleeper.app/v1';
const FANTASY_POSITIONS = new Set(['QB', 'RB', 'WR', 'TE', 'K', 'DEF']);
const PLAYERS_KEY = 'sa.players.v1';
const PLAYERS_TTL_MS = 12 * 60 * 60 * 1000;

async function get(path) {
  const res = await fetch(BASE + path);
  if (!res.ok) throw new Error(`Sleeper API returned ${res.status} for ${path}`);
  return res.json();
}

function readCache(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}

function writeCache(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or blocked (private mode): the app still works, it just refetches.
  }
}

export const getState = () => get('/state/nfl');
export const getUser = (username) => get(`/user/${encodeURIComponent(username)}`);
export const getLeagues = (userId, season) => get(`/user/${userId}/leagues/nfl/${season}`);
export const getLeague = (leagueId) => get(`/league/${leagueId}`);
export const getRosters = (leagueId) => get(`/league/${leagueId}/rosters`);
export const getLeagueUsers = (leagueId) => get(`/league/${leagueId}/users`);

export const getTrending = (type, hours = 24, limit = 200) =>
  get(`/players/nfl/trending/${type}?lookback_hours=${hours}&limit=${limit}`).catch(() => []);

// Stats and projections are undocumented endpoints Sleeper's own app uses.
// They can be missing early in a week, so failures resolve to an empty object.
export const getWeekProjections = (season, week) =>
  get(`/projections/nfl/regular/${season}/${week}`).catch(() => ({}));

export async function getWeekStats(season, week, { cacheable = false } = {}) {
  const key = `sa.stats.${season}.${week}`;
  if (cacheable) {
    const cached = readCache(key);
    if (cached) return cached;
  }
  const raw = await get(`/stats/nfl/regular/${season}/${week}`).catch(() => ({}));
  // Keep only players who actually played; drops ~90% of the payload.
  const trimmed = {};
  for (const [id, s] of Object.entries(raw)) if (s && s.gp > 0) trimmed[id] = s;
  if (cacheable && Object.keys(trimmed).length) writeCache(key, trimmed);
  return trimmed;
}

// The full player database is ~15MB, so it's trimmed to fantasy-relevant
// players and cached for 12 hours.
export async function getPlayers() {
  const cached = readCache(PLAYERS_KEY);
  if (cached && Date.now() - cached.t < PLAYERS_TTL_MS) return expandPlayers(cached.data);

  const raw = await get('/players/nfl');
  const data = {};
  for (const [id, p] of Object.entries(raw)) {
    if (!FANTASY_POSITIONS.has(p.position) || !(p.team || p.active)) continue;
    data[id] = [
      p.full_name || `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim(),
      p.position,
      (p.fantasy_positions || [p.position]).join('/'),
      p.team || '',
      p.injury_status || '',
      p.age ?? '',
      p.depth_chart_order ?? '',
    ];
  }
  writeCache(PLAYERS_KEY, { t: Date.now(), data });
  return expandPlayers(data);
}

function expandPlayers(data) {
  const players = {};
  for (const [id, [name, pos, fp, team, injury, age, depth]] of Object.entries(data)) {
    players[id] = {
      id,
      name,
      pos,
      fp: fp.split('/'),
      team,
      injury,
      age,
      depth,
    };
  }
  return players;
}
