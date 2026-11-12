# Music Quiz

A music quiz you play on a shared screen. Spotify plays through the browser tab, and song details stay hidden until you reveal them. Teams can play **on the host screen** (they call out or write down answers) or **with their phones** (they scan a QR code and type guesses).

```
public/index.html   host screen (Spotify, game flow, scoreboard)
public/play.html    team phone page
src/worker.js       Cloudflare Worker + Durable Object (one per game room)
```

## Run locally

```sh
npm install
npm run dev
```

Open **http://127.0.0.1:8888** in Chrome on the host laptop. Use `127.0.0.1`, not `localhost`, because Spotify rejects `localhost` redirect URIs.

Phones on the same Wi-Fi join through your laptop's network address. `npm run dev` puts that address in the QR code automatically (via `.dev.vars`). If macOS asks whether to allow incoming connections, allow them.

## Deploy to Cloudflare

```sh
npx wrangler login
npm run deploy
```

This prints your URL, for example `https://music-quiz.<you>.workers.dev`. A custom domain can be attached in the Cloudflare dashboard. Durable Objects work on the Workers free plan.

## One-time Spotify setup

1. Go to https://developer.spotify.com/dashboard and choose **Create app**.
2. Add a Redirect URI for every address you host from. Each must match exactly, with no trailing slash:
   - `http://127.0.0.1:8888` for local use
   - `https://music-quiz.<you>.workers.dev` (or your domain) for the deployed version
3. Tick **Web API** and **Web Playback SDK**.
4. Paste the app's **Client ID** into the quiz and choose **Connect Spotify**.

Only the host needs Spotify, and it must be a Premium account. In development mode, only accounts you add under *User Management* (plus your own) can log in. Team phones don't need Spotify at all.

## Playing

1. Paste a playlist link. Your own playlists work best.
2. Choose the game setup:
   - **Songs:** all of them, or a random selection of N.
   - **Teams:** *On this screen*, or *Join with phones*.
   - **Answers:** *Reveal at the end* (play everything, then review) or *Reveal after each song*.
3. **Start / Next (N)** plays a song. The clip starts at a random point unless you turn that off in Settings. **Space** plays or pauses, **B** replays the clip, **F** turns on fullscreen.
4. **Review** (answers at the end): each song plays again hidden. **Reveal (R)** shows it, **←/→** move between songs, and you tap **T** (title) or **A** (artist) for each team at any time. Each is worth 1 point, and tapping again undoes it.

**Accidental reload or crash:** the host page saves the game after every step. When you reopen it, an **Unfinished game** card offers to resume at the same song or review item, in the same phone room. Press Play to continue the song. The card disappears once a game is finished or discarded, or after 24 hours.

### With phones

- The start screen shows a QR code and a 4-letter code. The header's **JOIN ABCD** button shows them again for latecomers.
- Teams enter a name, then type a title and/or artist for each song. Guesses save automatically.
  - *Reveal at the end:* a guess can be changed until you press Next.
  - *Reveal after each song:* guesses lock when you press Reveal.
- While a song plays, the shared screen only shows which teams **answered**, never what they typed.
- In the review, every team's guess appears next to its name before you reveal the answer. You award points by hand. Nothing is matched automatically.
- Phones show live results during the review and the final ranking at the end. A phone that locks or reloads reconnects as the same team.
- Rooms are forgotten 24 hours after the last activity.

## Sharing to the TV

Share **only this tab or window**, not your whole screen. macOS's "Now Playing" menu and Chrome's media controls can show the song name, and sharing just the tab keeps those out of view. In Chrome, **Cast → Cast tab** sends both the picture and the sound to the TV.
