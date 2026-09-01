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

## Build the public demo

The public demo reuses the production interface with curated in-browser data. It does not require a server, database, account, or API connection.

```sh
npm run build:demo
```

The deployable static website is written to `dist/demo/`. It is built for the domain root and includes a fallback for client-side routes such as `/articles/unread`.

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

The Feedfold identity is a hard cutover: it uses a new macOS application identity and data directory rather than adopting data from an earlier installation automatically.

## Start feedfold with Docker Compose

The included Compose deployment runs one Node.js 24.18.0 process, starts sandboxed headless Chromium when a web feed loads, and stores SQLite data in a named volume.

You need Docker Engine with Docker Compose v2.

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

The Compose service and named volume also use the new Feedfold identity. An earlier deployment volume is left untouched and is not migrated automatically.

To follow the server logs:

```sh
docker compose logs -f --tail=200 feedfold
```

To stop feedfold without deleting its data:

```sh
docker compose down
```

Adding `--volumes` to this command permanently deletes the SQLite database.

Do not scale feedfold to multiple application replicas. Background polling and SQLite ownership are designed for one process.

## Keep access private

Compose publishes feedfold on host loopback by default. The first account can be created only while no account exists; account creation closes as soon as setup succeeds.

For access from another device, use a trusted private network or an HTTPS reverse proxy. Set `FEEDFOLD_PUBLIC_ORIGIN` to the exact external HTTPS origin, such as `https://reader.example.com`. This fixes the passkey relying-party identity, enables secure cookies, and rejects browser requests from other origins.

If you deliberately want anyone who can reach a public server to create an isolated account, set `FEEDFOLD_ALLOW_PUBLIC_REGISTRATION=1`. Leave it unset for personal or private deployments.

### Publish feedfold to a Tailscale network

On a host connected to Tailscale, publish the loopback service to its tailnet:

```sh
sudo tailscale serve --bg --https=443 http://127.0.0.1:3000
```

The command prints the private `https://<device>.<tailnet>.ts.net` address. HTTPS also enables browser features such as copy to clipboard. Tailscale Serve provisions the certificate and keeps a `--bg` configuration across restarts. See the [Tailscale Serve command reference](https://tailscale.com/docs/reference/tailscale-cli/serve).

To inspect the active configuration:

```sh
tailscale serve status
```

To stop publishing the service:

```sh
sudo tailscale serve --https=443 off
```

## Configuration reference

Compose reads these values from the shell or a project-level `.env` file:

| Variable | Default | Purpose |
| --- | --- | --- |
| `FEEDFOLD_BIND_ADDRESS` | `127.0.0.1` | Host address that publishes the container port. Keep loopback when a local reverse proxy provides access. |
| `FEEDFOLD_PORT` | `3000` | Host port forwarded to feedfold. |
| `FEEDFOLD_BASE_PATH` | `/` | Browser-facing path where feedfold is mounted. Set this at build time, including the leading and trailing slash, when a reverse proxy publishes feedfold below a path such as `/feedfold/`. |
| `POLL_INTERVAL_MINUTES` | `20` | Starting interval for new published feeds, rounded up to 5, 10, 20, 30, or 60 minutes. |
| `FEED_FETCH_TIMEOUT_MS` | `15000` | Feed request timeout, in milliseconds. |
| `WEB_FEED_LOAD_TIMEOUT_MS` | `30000` | Maximum normal load time for a JavaScript-rendered web feed, in milliseconds. |
| `ARTICLE_FETCH_TIMEOUT_MS` | `20000` | Full-article request timeout, in milliseconds. |
| `AI_CREDENTIALS_KEY` | none | Persistent 64-character hexadecimal key used to encrypt provider API keys. AI key storage remains unavailable until this is set. |
| `AI_REQUEST_TIMEOUT_MS` | `60000` | AI provider request timeout, in milliseconds. |

The container fixes its internal runtime settings to `HOST=0.0.0.0`, `PORT=3000`, and `DATABASE_PATH=/data/feedfold.db`. For a non-container deployment, `.env.example` lists every server setting.

After changing container configuration, recreate the service:

```sh
docker compose up -d
```

The server continues background polling when no browser is open. Published feeds start at the interval chosen in **Settings**, while web feeds start at 60 minutes. Each feed then adapts between 5, 10, 20, 30, and 60 minutes according to how often it produces new posts. Manual refreshes do not affect this schedule.

## Add a web feed

Use a web feed when a public page has repeated entries but no published RSS, Atom, or JSON Feed.

1. In **Manage feeds**, choose **Add feed**.
2. Enter any page on the website and choose **Check URL**. feedfold looks for a published feed first.
3. If no published feed exists, choose **Create web feed**.
4. Choose a suggested entry group, or select one representative entry in the page preview.
5. Review the feed preview and choose **Add web feed**.

During a refresh, feedfold reloads the configured page in Chromium. It updates existing links, adds each new link once, and keeps entries that disappear from the page in feed history. When an entry has no publication date, feedfold uses the time it first discovered the entry.

If the page changes and the saved selection stops matching, open the feed's actions and choose **Edit page selection**. Repairing the selection keeps saved articles and their reading state.

### Web feed limits

A web feed follows repeated entries from one publicly accessible page after a normal load. It does not:

- sign in to a website;
- bypass a paywall, CAPTCHA, bot check, or other access control;
- follow pagination or crawl an entire website;
- monitor arbitrary text or prices;
- compare screenshots.

feedfold reports temporary loading failures and JavaScript timeouts separately from a broken saved selection. It rejects pages that cannot become reliable feeds before creating a subscription.

The Compose deployment runs Chromium as the non-root application user with its Linux sandbox enabled. It uses the version-pinned [Playwright seccomp profile](https://github.com/microsoft/playwright/blob/v1.62.0/utils/docker/seccomp_profile.json) and restores only the `SYS_CHROOT` capability required by that sandbox.

## Enable AI summaries and translations

1. Generate a persistent encryption key:

   ```sh
   openssl rand -hex 32
   ```

2. Save the generated value as `AI_CREDENTIALS_KEY` in the project-level `.env` file.
3. Recreate the service.
4. Open **Settings → AI**.
5. Choose Google Gemini, OpenAI, or Anthropic.
6. Enter a model ID and save the provider's API key.

Summaries, translations, and custom prompts use the same provider and model. Each provider begins with a recommended model ID, but the model field accepts any model available to your provider account. You can edit the default summary and translation prompts for each feedfold account and add named prompts to the article's AI menu.

feedfold encrypts provider keys per account before storing them in SQLite. It does not return a saved key to the browser.

## Update feedfold

1. Pull the latest commit:

   ```sh
   git pull --ff-only
   ```

2. Rebuild and restart the service:

   ```sh
   docker compose up -d --build
   ```
