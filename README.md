# feedfold

feedfold is the feed reader I built for myself. Try demo at https://feedfold.com.

## See feedfold

| Reader | Filters |
| :---: | :---: |
| [![feedfold magazine view populated with demo feeds](docs/screenshots/reader-desktop.png)](docs/screenshots/reader-desktop.png) | [![A feedfold rule that hides matching articles](docs/screenshots/filters-desktop.png)](docs/screenshots/filters-desktop.png) |
| **YouTube article** | **X / Nitter post** |
| [![A YouTube video open in feedfold](docs/screenshots/article-youtube.png)](docs/screenshots/article-youtube.png) | [![An X post open in feedfold](docs/screenshots/article-nitter.png)](docs/screenshots/article-nitter.png) |

## Features

- Supports websites without RSS, Atom, or JSON feeds by extracting repeated entries from webpages, including pages rendered by JavaScript.
- Filters feeds by removing YouTube Shorts or matching words.
- Extracts full article text.
- Installs as a Progressive Web App with a standalone window, home-screen shortcuts, and an offline application shell.
- Supports OpenAI, Anthropic, and Gemini models for custom workflows such as summaries and article fact-checking.
- OPML import/export.
- Preserves separate sorting settings for each feed or folder in the aggregate view. For example, you can configure X.com posts to always display chronologically from oldest to newest without affecting the sorting method for other feeds.

## Run the macOS desktop app

The Electron app is fully local. It opens no HTTP port, needs no account or hosted backend, and sends application requests through a narrow IPC bridge. SQLite, background refreshes, article extraction, and the bundled headless browser all run inside the app. The hosted version remains available separately.

After the first Feedfold release is published, install the Apple silicon build with Homebrew:

```sh
brew install --cask egornomic/tap/feedfold
```

For local development:

```sh
npm run dev:desktop
```

To build and open the desktop app:

```sh
npm run build && npm run desktop
```

To create distributable DMG and ZIP artifacts in `release/`:

```sh
npm run desktop:package
```

Desktop data is stored at `~/Library/Application Support/feedfold/feedfold.db`. Provider API keys are encrypted using secure storage in macOS before they enter SQLite. Feed refreshes continue while the app is running; use **feedfold → Quit feedfold** or <kbd>⌘Q</kbd> to stop it completely.

## Start feedfold with Docker Compose

The included Compose deployment runs one Node.js 24.18.0 process, starts sandboxed headless Chromium when a web feed loads, and stores SQLite data in a named volume.

1. Build and start feedfold:

   ```sh
   docker compose up -d --build
   ```

2. Open `http://localhost:3000/`. Using `localhost` also enables passkeys during local access.

3. Choose **Create the first account**. Setup signs in the new account immediately and then closes public account creation.

4. Check that the container is ready:

   ```sh
   docker compose ps
   ```

5. Check that the server can query SQLite:

   ```sh
   curl --fail http://127.0.0.1:3000/health
   ```

The health endpoint returns HTTP 200 when the SQLite query succeeds. Application data is stored in the `feedfold-data` volume at `/data/feedfold.db`.

## Configuration reference

Compose reads these values from the shell or a project-level `.env` file:

| Variable | Default | Purpose |
| --- | --- | --- |
| `FEEDFOLD_BIND_ADDRESS` | `127.0.0.1` | Host address that publishes the container port. Keep loopback when a local reverse proxy provides access. |
| `FEEDFOLD_PORT` | `3000` | Host port forwarded to feedfold. |
| `FEEDFOLD_BASE_PATH` | `/` | Browser-facing path where feedfold is mounted. Set this at build time, including the leading and trailing slash, when a reverse proxy publishes feedfold below a path such as `/feedfold/`. |
| `FEEDFOLD_DEPLOYMENT_MODE` | `private` | Use `private` for unrestricted desktop and self-hosted operation, or `public` for public-service inactivity, refresh, and subscription limits. |
| `FEEDFOLD_PUBLIC_ORIGIN` | none | Exact external HTTPS origin used for secure cookies, passkeys, and browser-origin validation. |
| `FEEDFOLD_MAX_ACCOUNTS` | none | Public-mode account cap. `0`, a missing value, or an invalid value disables registration. |
| `FEEDFOLD_RECENT_AUTH_SECONDS` | `300` | Time after authentication during which credential changes do not require another check. |
| `FEEDFOLD_REGISTRATION_IP_LIMIT` | `10` | Registration attempts allowed per source during the registration cooldown. |
| `FEEDFOLD_REGISTRATION_GLOBAL_LIMIT` | `100` | Registration attempts allowed across the deployment during the registration cooldown. |
| `FEEDFOLD_REGISTRATION_COOLDOWN_MINUTES` | `60` | Registration cooldown window. |
| `FEEDFOLD_LOGIN_IP_LIMIT` | `50` | Failed sign-in attempts allowed per source during the login cooldown. |
| `FEEDFOLD_LOGIN_ACCOUNT_LIMIT` | `10` | Failed sign-in attempts allowed per account name during the login cooldown. |
| `FEEDFOLD_LOGIN_COOLDOWN_MINUTES` | `15` | Login cooldown window. |
| `FEEDFOLD_STEP_UP_LIMIT` | `10` | Failed recent-authentication attempts allowed per session during its cooldown. |
| `FEEDFOLD_STEP_UP_COOLDOWN_MINUTES` | `15` | Recent-authentication cooldown window. |
| `POLL_INTERVAL_MINUTES` | `20` | Starting interval for new published feeds, rounded up to 5, 10, 20, 30, or 60 minutes. |
| `FEED_FETCH_TIMEOUT_MS` | `15000` | Feed request timeout, in milliseconds. |
| `WEB_FEED_LOAD_TIMEOUT_MS` | `30000` | Maximum normal load time for a JavaScript-rendered web feed, in milliseconds. |
| `ARTICLE_FETCH_TIMEOUT_MS` | `20000` | Full-article request timeout, in milliseconds. |
| `AI_CREDENTIALS_KEY` | none | Persistent 64-character hexadecimal key used to encrypt provider API keys. AI key storage remains unavailable until this is set. |
| `AI_REQUEST_TIMEOUT_MS` | `60000` | AI provider request timeout, in milliseconds. |

The container fixes its internal runtime settings to `HOST=0.0.0.0`, `PORT=3000`, and `DATABASE_PATH=/data/feedfold.db`. For a non-container deployment, `.env.example` lists every server setting.
