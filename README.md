# Sleeper-Aid

A browser app that reads your [Sleeper](https://sleeper.com) fantasy football leagues and helps with lineups, the league picture and the waiver wire.

It talks straight to Sleeper's public, read-only API from the browser. There's no server, login or API key, only a Sleeper username. It can't make moves; you make them in the Sleeper app.

## Features

- **My Team:** record, points and waiver priority or FAAB. Shows the best lineup for the selected week by projection, which players to start or bench compared with your current Sleeper lineup, injury and bye alerts, and how your starters rank against the league at each position.
- **League:** standings, with each team's rank at every position. Tap a team to see its roster, sorted by value. Also suggests trade partners whose surplus matches your needs and the other way around.
- **Waivers:** every unrostered player, ranked by how much they would improve your best lineup for the rest of the season and for the selected week. Shows who to drop, your weak spots, the teams on bye, and how many Sleeper users added each player in the last 24 hours.

## How players are valued

- Points are calculated with **your league's own scoring settings**, applied to Sleeper's weekly stats and projections.
- **Value** blends three numbers: this week's projection (50%), the average of the last 3 games (30%) and the season average (20%). If a player is on bye, or out for the week but not on IR, next week's projection is used instead. Players on IR are discounted.
- **Season +** on the Waivers tab adds the free agent to your roster, drops your least useful player if the roster is full, re-optimises your lineup and reports the change in points.

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

## Roadmap

- Draft helper: follow a live draft, show the best players still available and suggest picks based on roster needs.
