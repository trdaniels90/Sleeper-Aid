// Scoring, player valuation, lineup optimisation and waiver logic.
// Everything here is pure: it takes plain data and returns plain data.

export const MAIN_POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];

const SLOT_ELIGIBILITY = {
  QB: ['QB'],
  RB: ['RB'],
  WR: ['WR'],
  TE: ['TE'],
  K: ['K'],
  DEF: ['DEF'],
  FLEX: ['RB', 'WR', 'TE'],
  WRRB_FLEX: ['RB', 'WR'],
  REC_FLEX: ['WR', 'TE'],
  SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'],
};

// Statuses where the player will not suit up.
const OUT_STATUSES = new Set(['Out', 'IR', 'PUP', 'Sus', 'NA', 'DNR', 'COV']);

export const isOut = (p) => OUT_STATUSES.has(p.injury);

const round1 = (n) => Math.round(n * 10) / 10;
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

// Sleeper stat keys line up with the league's scoring_settings keys, so a
// player's fantasy points are just the dot product of the two.
export function scorePoints(stats, scoring) {
  if (!stats) return null;
  let total = 0;
  for (const [key, weight] of Object.entries(scoring)) {
    if (stats[key]) total += stats[key] * weight;
  }
  return Math.round(total * 100) / 100;
}

// A team is on bye in a week when none of its players has a projection.
export function findByeTeams(projections, players) {
  const allTeams = new Set();
  const playing = new Set();
  for (const p of Object.values(players)) if (p.team && p.pos !== 'DEF') allTeams.add(p.team);
  for (const [id, proj] of Object.entries(projections)) {
    const p = players[id];
    if (p?.team && (proj.pts_ppr > 0 || proj.pts_std > 0)) playing.add(p.team);
  }
  // No projections at all means the data isn't out yet, not that everyone's on bye.
  if (playing.size === 0) return new Set();
  return new Set([...allTeams].filter((t) => !playing.has(t)));
}

// ---------- matchups ----------

// Each defense's weekly stat line includes the fantasy points it gave up to
// opposing QBs/RBs/WRs/TEs/Ks, plus what its offense gave up to opposing
// defenses (fan_pts_allow_def). Averaging those over the season tells us how
// generous each team is to each position.
const ALLOW_KEYS = { QB: 'fan_pts_allow_qb', RB: 'fan_pts_allow_rb', WR: 'fan_pts_allow_wr', TE: 'fan_pts_allow_te', K: 'fan_pts_allow_k', DEF: 'fan_pts_allow_def' };
const SHRINK_GAMES = 3; // regress small samples toward average
const FACTOR_RANGE = [0.75, 1.25];

export function buildMatchups(weeklyStats, schedule) {
  const totals = {}; // team -> pos -> [sum, games]
  for (const { stats } of weeklyStats) {
    for (const [team, s] of Object.entries(stats)) {
      if (!s.fan_pts_allow && s.fan_pts_allow !== 0) continue; // only team defense lines
      for (const [pos, key] of Object.entries(ALLOW_KEYS)) {
        if (s[key] === undefined) continue;
        const t = ((totals[team] ??= {})[pos] ??= [0, 0]);
        t[0] += s[key];
        t[1] += 1;
      }
    }
  }

  const avgAllowed = {}; // pos -> team -> avg
  const leagueAvg = {};
  const ranks = {}; // pos -> team -> rank (1 = gives up the most)
  for (const pos of Object.keys(ALLOW_KEYS)) {
    avgAllowed[pos] = {};
    for (const [team, byPos] of Object.entries(totals)) if (byPos[pos]?.[1]) avgAllowed[pos][team] = byPos[pos][0] / byPos[pos][1];
    const vals = Object.values(avgAllowed[pos]);
    leagueAvg[pos] = vals.length ? vals.reduce((x, y) => x + y, 0) / vals.length : 0;
    ranks[pos] = {};
    Object.entries(avgAllowed[pos])
      .sort((x, y) => y[1] - x[1])
      .forEach(([team], i) => (ranks[pos][team] = i + 1));
  }

  const opponents = {}; // week -> team -> { opp, home }
  for (const g of schedule) {
    const wk = (opponents[g.week] ??= {});
    wk[g.home] = { opp: g.away, home: true };
    wk[g.away] = { opp: g.home, home: false };
  }

  // Multiplier for a player at `pos` facing `opp`: >1 means a soft matchup.
  const factor = (opp, pos) => {
    const allowed = avgAllowed[pos]?.[opp];
    if (allowed === undefined || !leagueAvg[pos]) return 1;
    const games = totals[opp][pos][1];
    const raw = 1 + (allowed / leagueAvg[pos] - 1) * (games / (games + SHRINK_GAMES));
    return Math.min(FACTOR_RANGE[1], Math.max(FACTOR_RANGE[0], raw));
  };

  return {
    teamCount: Object.keys(avgAllowed.WR || {}).length,
    opponent: (team, week) => opponents[week]?.[team] ?? null,
    hasWeek: (week) => Boolean(opponents[week]),
    teamsPlaying: (week) => new Set(Object.keys(opponents[week] || {})),
    factor,
    rank: (opp, pos) => ranks[pos]?.[opp] ?? null,
    allowed: (opp, pos) => avgAllowed[pos]?.[opp] ?? null,
    leagueAvg: (pos) => leagueAvg[pos] ?? null,
  };
}

// Builds per-player numbers for one league's scoring:
//   avg  - season points per game, l3 - average of the last 3 games played,
//   proj - projection for the selected week, value - blended rest-of-season worth.
//   opp/matchup - this week's opponent and how generous they are to the position,
//   rosFactor - average matchup over the rest of the fantasy season.
export function buildPlayerStats({ players, weeklyStats, projections, nextProjections, scoring, byeTeams, nextByeTeams, trendingAdds, trendingDrops, matchups, week, lastWeek }) {
  const adds = new Map(trendingAdds.map((t, i) => [t.player_id, { count: t.count, rank: i + 1 }]));
  const drops = new Map(trendingDrops.map((t) => [t.player_id, t.count]));

  const out = {};
  for (const p of Object.values(players)) {
    const games = [];
    for (const { week, stats } of weeklyStats) {
      const pts = scorePoints(stats[p.id], scoring);
      if (pts !== null) games.push({ week, pts, stats: stats[p.id] });
    }
    const season = games.reduce((a, g) => a + g.pts, 0);
    const seasonAvg = avg(games.map((g) => g.pts));
    const l3 = avg(games.slice(-3).map((g) => g.pts));

    const onBye = byeTeams.has(p.team);
    let proj = projections[p.id] ? scorePoints(projections[p.id], scoring) : null;
    if (onBye) proj = 0;
    if (isOut(p)) proj = 0;
    const nextProj = nextProjections[p.id] && !nextByeTeams.has(p.team) ? scorePoints(nextProjections[p.id], scoring) : null;

    // Matchups: this week's opponent, and the average over the remaining
    // fantasy weeks (the player's strength of schedule).
    const game = p.team ? matchups.opponent(p.team, week) : null;
    const matchupFactor = game ? matchups.factor(game.opp, p.pos) : 1;
    const rest = [];
    for (let w = week; w <= lastWeek; w++) {
      const g = p.team ? matchups.opponent(p.team, w) : null;
      if (g) rest.push(matchups.factor(g.opp, p.pos));
    }
    const rosFactor = rest.length ? rest.reduce((a, b) => a + b, 0) / rest.length : 1;

    // For long-term value, a bye or a short absence shouldn't sink a player,
    // so fall back to next week's projection when this week's is zeroed out.
    // Sleeper's projections already account for the opponent; past scoring
    // doesn't, so it's scaled by how soft or tough the remaining schedule is.
    const valueProj = onBye || (isOut(p) && p.injury !== 'IR') ? nextProj : proj;
    const parts = [
      [valueProj, 0.5],
      [l3 === null ? null : l3 * rosFactor, 0.3],
      [seasonAvg === null ? null : seasonAvg * rosFactor, 0.2],
    ].filter(([v]) => v !== null);
    const weight = parts.reduce((a, [, w]) => a + w, 0);
    let value = weight ? parts.reduce((a, [v, w]) => a + v * w, 0) / weight : 0;
    if (p.injury === 'IR') value *= 0.25;

    out[p.id] = {
      ...p,
      games,
      gp: games.length,
      season: round1(season),
      avg: seasonAvg === null ? null : round1(seasonAvg),
      l3: l3 === null ? null : round1(l3),
      proj: proj === null ? null : round1(proj),
      nextProj: nextProj === null ? null : round1(nextProj),
      value: round1(value),
      onBye,
      opp: game?.opp ?? null,
      home: game?.home ?? null,
      matchupFactor,
      matchupRank: game ? matchups.rank(game.opp, p.pos) : null,
      rosFactor,
      trendAdd: adds.get(p.id)?.count ?? 0,
      trendRank: adds.get(p.id)?.rank ?? null,
      trendDrop: drops.get(p.id) ?? 0,
    };
  }
  return out;
}

// Points used to set a lineup for the selected week.
export const weekScore = (p) => {
  if (p.onBye || isOut(p)) return 0;
  if (p.proj !== null) return p.proj;
  // No projection: fall back to recent form, adjusted for the opponent.
  return (p.l3 ?? p.avg ?? 0) * (p.matchupFactor ?? 1);
};

export const valueScore = (p) => p.value;

export const startingSlots = (rosterPositions) => rosterPositions.filter((s) => SLOT_ELIGIBILITY[s]);

// Every position that can fill at least one of the given starting slots.
export const startablePositions = (slots) => new Set(slots.flatMap((s) => SLOT_ELIGIBILITY[s]));

const canPlay = (p, slot) => p.fp.some((pos) => SLOT_ELIGIBILITY[slot].includes(pos));

// Greedy optimiser: fill the most restrictive slots first (QB, RB, ...)
// then the flex slots. Optimal for standard Sleeper slot types.
export function bestLineup(roster, slots, scoreFn) {
  const order = slots
    .map((slot, i) => ({ slot, i }))
    .sort((a, b) => SLOT_ELIGIBILITY[a.slot].length - SLOT_ELIGIBILITY[b.slot].length);
  const used = new Set();
  const lineup = new Array(slots.length);
  for (const { slot, i } of order) {
    let best = null;
    for (const p of roster) {
      if (used.has(p.id) || !canPlay(p, slot)) continue;
      if (!best || scoreFn(p) > scoreFn(best)) best = p;
    }
    if (best) used.add(best.id);
    lineup[i] = { slot, player: best };
  }
  const total = lineup.reduce((a, s) => a + (s.player ? scoreFn(s.player) : 0), 0);
  return { lineup, total: round1(total) };
}

// Strength at each position = value of the players who'd start there in the
// team's best rest-of-season lineup (flex players count toward their own position).
export function positionStrength(roster, slots) {
  const { lineup } = bestLineup(roster, slots, valueScore);
  const strength = Object.fromEntries(MAIN_POSITIONS.map((p) => [p, 0]));
  for (const { player } of lineup) if (player) strength[player.pos] = (strength[player.pos] ?? 0) + player.value;
  for (const k of Object.keys(strength)) strength[k] = round1(strength[k]);
  return strength;
}

// Rank every team (1 = best) at each position the league actually starts.
export function rankPositions(teams, positions) {
  const ranks = new Map(teams.map((t) => [t.rosterId, {}]));
  for (const pos of positions) {
    const sorted = [...teams].sort((a, b) => b.strength[pos] - a.strength[pos]);
    sorted.forEach((t, i) => (ranks.get(t.rosterId)[pos] = i + 1));
  }
  return ranks;
}

// Rough chance a starter at each position misses a given week (bye or injury).
// Kickers and defenses get streamed off waivers, so backups there earn nothing.
const MISS_RATE = { QB: 0.08, RB: 0.18, WR: 0.15, TE: 0.12, K: 0, DEF: 0 };

// Rest-of-season worth of a roster: the best lineup, plus bench depth measured
// as the points the bench saves when each starter misses a week.
export function rosterValue(roster, slots) {
  const { lineup, total } = bestLineup(roster, slots, valueScore);
  let depth = 0;
  for (const { player } of lineup) {
    if (!player) continue;
    const covered = bestLineup(roster.filter((p) => p.id !== player.id), slots, valueScore).total;
    depth += (MISS_RATE[player.pos] ?? 0.1) * (covered - (total - player.value));
  }
  return total + depth;
}

// For every free agent: how much does adding them improve my roster,
// both for the selected week and rest of season? And who would I drop?
export function analyzeWaivers({ myRoster, freeAgents, slots, rosterSize }) {
  const baseLineup = bestLineup(myRoster, slots, valueScore);
  const base = rosterValue(myRoster, slots);
  const baseWeek = bestLineup(myRoster, slots, weekScore).total;
  const needsDrop = myRoster.length >= rosterSize;

  // Cost of losing each of my players, used to pick a drop candidate.
  const dropCosts = myRoster
    .map((p) => {
      const without = myRoster.filter((x) => x.id !== p.id);
      return { player: p, cost: round1(base - rosterValue(without, slots)) };
    })
    .sort((a, b) => a.cost - b.cost || a.player.value - b.player.value);

  const results = freeAgents.map((fa) => {
    const withFa = [...myRoster, fa];
    let gain = rosterValue(withFa, slots) - base;
    let weekGain = bestLineup(withFa, slots, weekScore).total - baseWeek;
    let drop = null;
    if (needsDrop) {
      // Best player to drop once this FA is on the roster (never the FA themself).
      let bestTotal = -Infinity;
      for (const p of myRoster) {
        const total = rosterValue(withFa.filter((x) => x.id !== p.id), slots);
        // Near-ties go to dropping the lower-value player (e.g. a spare defense).
        if (total > bestTotal + 0.05 || (total > bestTotal - 0.05 && p.value < drop.value)) {
          bestTotal = total;
          drop = p;
        }
      }
      gain = bestTotal - base;
      weekGain = bestLineup(withFa.filter((x) => x.id !== drop.id), slots, weekScore).total - baseWeek;
    }
    // How close the FA is to cracking my lineup: value vs. the weakest starter they could replace.
    const replaceable = baseLineup.lineup.filter((s) => s.player && canPlay(fa, s.slot)).map((s) => s.player.value);
    const margin = replaceable.length ? round1(fa.value - Math.min(...replaceable)) : -Infinity;
    return { player: fa, gain: round1(gain), weekGain: round1(weekGain), drop, margin };
  });

  return { results, dropCosts, needsDrop };
}

const MIN_SEASON_GAIN = 0.5; // pts/week worth spending a roster spot on
const MIN_WEEK_GAIN = 1.5; // pts this week worth a one-week fill-in

// Greedy add/drop plan: take the single best pickup, apply it to the roster,
// then look again, so suggested moves never reuse the same drop.
export function recommendMoves({ myRoster, freeAgents, slots, rosterSize, max = 3 }) {
  let roster = myRoster;
  let pool = freeAgents.filter((p) => !isOut(p));
  const moves = [];
  while (moves.length < max) {
    const { results } = analyzeWaivers({ myRoster: roster, freeAgents: pool, slots, rosterSize });
    const best = results.sort((a, b) => b.gain - a.gain || b.weekGain - a.weekGain)[0];
    if (!best || best.gain < MIN_SEASON_GAIN) break;
    moves.push({ ...best, kind: 'season' });
    roster = [...roster.filter((p) => p.id !== best.drop?.id), best.player];
    pool = pool.filter((p) => p.id !== best.player.id);
  }

  // A one-week fill-in (bye or injury cover) that doesn't cost long-term value:
  // never drop someone more valuable than the fill-in for a single week.
  const { results } = analyzeWaivers({ myRoster: roster, freeAgents: pool, slots, rosterSize });
  const fillIn = results
    .filter((r) => r.weekGain >= MIN_WEEK_GAIN && r.gain > -0.5 && (!r.drop || r.drop.value <= r.player.value))
    .sort((a, b) => b.weekGain - a.weekGain)[0];
  if (fillIn) moves.push({ ...fillIn, kind: 'week' });

  return moves;
}
