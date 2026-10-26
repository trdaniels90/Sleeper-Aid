# Sleeper-Aid

A browser app that reads your [Sleeper](https://sleeper.com) fantasy football leagues and helps with lineups, the league picture, the waiver wire and free agency.

It talks straight to Sleeper's public, read-only API from the browser. There's no server, login or API key, only a Sleeper username. It can't make moves; you make them in the Sleeper app.

## Features

- **Breakout ticker:** a scrolling strip at the top listing free agents in your league who scored at least 15 points in the latest week, and at least 1.5× their previous average. Tap a name for their details. It pauses on hover, and if your phone is set to reduce motion it becomes a strip you swipe instead.
- **My Team:** record, points and waiver priority or FAAB. Shows the best lineup for the selected week by projection, which players to start or bench compared with your current Sleeper lineup, injury and bye alerts, and how your starters rank against the league at each position.
- **League:** standings, with each team's rank at every position. Tap a team to see its roster, sorted by value. Also suggests trade partners whose surplus matches your needs and the other way around.
- **Moves:** your plan for the week in one place.
  - **Start/sit:** who to start and bench, compared with the lineup currently set in Sleeper.
  - **Recommended pickups:** up to 3 add/drop pairs chosen one at a time, so no two moves drop the same player. Can also include one fill-in pickup for a week with a bye or injury.
  - **Best available by position:** the top 4 free agents at each position, each marked *Add · drop X*, *Week N only*, or *Bench depth*.
  - **All free agents:** a full table you can sort and filter by position.
- **Player details:** tap any player to see their season totals, points by week with the upcoming projection, and a game log with position-specific stats (passing, rushing, receiving and snap share, field goals, or defense numbers), all scored with your league's settings.

## How players are valued

- Points are calculated with **your league's own scoring settings**, applied to Sleeper's weekly stats and projections.
- **Value** blends three numbers: this week's projection (50%), the average of the last 3 games (30%) and the season average (20%). If a player is on bye, or out for the week but not on IR, next week's projection is used instead. Players on IR are discounted.
- The app defaults to the upcoming week. From Monday to Wednesday that's next week, because the current week's games are done and waiver claims are for next week. You can change it with the week picker.
- **Season +** on the Moves tab adds the free agent to your roster, drops the player you'd miss least if the roster is full, re-optimises your lineup and reports the change. Bench depth counts too. For each starter, the app works out how many points your bench would save if that starter missed a week, weighted by how often players at that position miss (about 18% for RBs, 15% for WRs, 12% for TEs, 8% for QBs; backup kickers and defenses count for nothing since you can stream them). A backup RB or WR is worth keeping; a third QB isn't.

## Running it

It's plain HTML and JavaScript with no build step. Serve the folder with any static server:

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

It opens on `trdaniels90` by default. Change the username in the top bar or use `?user=<name>`.

### Host it free on GitHub Pages

In the repository, go to **Settings → Pages**. Under **Build and deployment**, pick **Deploy from a branch**, then choose the branch and `/ (root)`. The app will be live at `https://<github-user>.github.io/Sleeper-Aid/`.

## Code layout

- `index.html` is the page shell.
- `css/style.css` holds the styles, including light and dark mode and the phone layout.
- `js/api.js` handles Sleeper API calls and caching. The player list is cached for 12 hours, and finished weeks of stats are cached.
- `js/analysis.js` does the scoring, player values, lineup optimiser and waiver analysis.
- `js/app.js` holds the app state, rendering and event handling.
