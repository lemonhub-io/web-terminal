# web-terminal

Run real login shells in a browser, with persistent tabs, automatic reconnect,
and a key bar for phones. The client uses TypeScript and
[xterm.js](https://xtermjs.org/). A Node.js web service handles sign-in and
serves the client. A separate shell host owns the terminals and their
scrollback so they can outlive the browser and web service.

## Quick start

You need Node.js 24 or later, a C/C++ toolchain for `node-pty` (such as
`build-essential` on Debian or Ubuntu), and an HTTPS reverse proxy such as
Caddy.

```sh
git clone https://github.com/lemonhub-io/web-terminal.git
cd web-terminal
npm ci
npm run build
npm run passwd
npm start
```

Point your proxy at `127.0.0.1:3120` and sign in at the proxy’s HTTPS address.
Use [the example Caddyfile](deploy/Caddyfile.example) and replace the hostname
with your domain. `npm run passwd` adds an account or updates its password.
For a non-interactive setup, supply the password on standard input.

```sh
printf '%s\n' "$PASSWORD" | WEB_TERMINAL_USERNAME=alice npm run passwd
```

## Using the terminal

### Tabs and sign-in

- Choose **+** to open a terminal. When signed in to several accounts, choose
  which one should launch the shell. Double-click a tab to rename it. Its
  close button asks for confirmation before ending the shell.
- Use **Settings** → **Sign in to another account** to sign in to up to eight
  accounts in one browser. The tab strip shows the terminals from those
  accounts together.
- Each fresh sign-in opens its own session, even when several people use the
  same account. A session holds a group of terminal tabs. Use **Sessions** in
  the toolbar to view the sessions for a signed-in account, open a different
  one, or create, rename, and delete sessions. Deletion asks for confirmation
  and closes the terminals in that session.
- A browser tab remembers its session choice across reloads. Switching leaves
  the other session's shells running. Opening the same session in two browser
  tabs connects both to the same shells. Reconnecting restores the screen,
  scrollback, cursor, and program modes.
- Signing out clears that browser login. The next sign-in starts a fresh
  session, and **Sessions** still lists the account's saved sessions.

### Text selection and clipboard

- **Mouse:** Drag to select text, including in programs with mouse tracking
  such as tmux. A plain click and the wheel still reach the program.
  Use the copy button or your usual clipboard shortcut.
- **Touch:** Hold a word briefly to select it, or tap **Select text** in the
  toolbar and drag across the text. After lifting your finger, drag either
  handle to adjust the range. Hold a handle near the edge of the screen to
  extend into available scrollback.
- **Copy:** Tap **Copy** beside the touch selection. When clipboard access is
  unavailable, the same toolbar opens a selectable text box for the device’s
  copy menu. Tap **Done** to return to normal terminal input and swiping.
- **Keyboard:** On Windows and Linux, Ctrl+C copies a selection and sends an
  interrupt when no text is selected. Ctrl+Shift+C copies. Ctrl+V pastes.
  On macOS, use Command+C and Command+V. Shift+Enter sends a line break to
  programs that support it. Applications can write to the clipboard with
  OSC 52. Clipboard contents are available to the terminal through user paste.

### Display and phone controls

The terminal supports light and dark themes, Windows Terminal JSON theme
imports, four bundled code fonts, and locally installed fonts. Font size,
line height, cursor, theme, and key bar preferences stay in the browser.
Bundled fallback fonts cover symbols and Nerd Font icons. Unicode 11 cell
widths match on the client and host, including when restoring a screen.
The palettes keep ANSI black dark and white light. Applications can use
`COLORFGBG`, OSC 10/11 color queries, and mode 2031 for theme information.

On a phone, swipe to scroll history or navigate full-screen programs. The key
bar adds Esc, Tab, Ctrl, Alt, arrows, and Paste. The layout follows the
visible screen when the keyboard opens. Browsers that support web app
installation can add the terminal to the home screen.

### Remote files

Open **Files** in the toolbar. The file manager starts in the selected
account's home directory. Open a folder, go to its parent, or enter an absolute
path. You can show hidden files, create folders, upload several files, download
files, and rename or delete items. Click a file name to download it. Replacing
an existing upload or deleting an item asks for confirmation. Deleting a
folder removes its contents as well.

Use the account selector to manage files for another signed-in account. File
operations run as the same operating-system user as that account's shells.
Sessions under the same account share the filesystem visible to that user.

## Deployment

### Services and proxy

For a persistent deployment on Linux, start with a built checkout and a
configured account. Stop any foreground instance and install both example
systemd user units. Set their working directories to this checkout and their
`ExecStart` paths to the absolute path of Node.js 24 or later.

```sh
mkdir -p ~/.config/systemd/user
cp deploy/web-terminal*.service ~/.config/systemd/user/
# Edit the copied units if your checkout or Node path differs.
systemctl --user daemon-reload
systemctl --user enable --now web-terminal-host web-terminal
```

`web-terminal` serves the client and API. It relays terminal WebSockets to
`web-terminal-host` over the private `host.sock` Unix socket. With a plain
`npm start`, the web service starts a host if one is missing. Use the separate
units to keep host lifetime independent of web service restarts.

Keep `OOMPolicy=continue` in the units so other shells can keep running after
an out-of-memory kill in one shell. Serve the proxy over HTTPS and keep the
web service bound to loopback. The Caddy example forwards WebSockets and
supplies the client address for sign-in throttling.

### Client builds from GitHub Actions

The [Build workflow](https://github.com/lemonhub-io/web-terminal/actions/workflows/build.yml)
runs on pushes to `main`, pull requests, and manual dispatch. It builds the
client from the lockfile and checks session switching, touch selection,
clipboard behavior, and file navigation in Chromium. The `web-terminal-client` artifact
contains the contents of `client/dist/`. Use an artifact from a successful
run for the revision you are deploying.

From the checkout on the server, replace `RUN_ID` with that run’s ID. An
authenticated GitHub CLI extracts the named artifact into the staging directory.
[GitHub CLI reference](https://cli.github.com/manual/gh_run_download)

```sh
(
  set -e
  mkdir -p var
  staging=$(mktemp -d var/client-release.XXXXXX)
  gh run download RUN_ID --repo lemonhub-io/web-terminal \
    --name web-terminal-client --dir "$staging"
  test -s "$staging/index.html"
  if [ -d client/dist ]; then
    backup=$(mktemp -d var/client-backup.XXXXXX)
    mv client/dist "$backup/dist"
  fi
  mv "$staging" client/dist
  systemctl --user reload web-terminal
)
```

The workflow publishes a build artifact. The deployment server installs it
and reloads its own service. Install the regular runtime dependencies with
`npm ci` when setting up the server or updating its dependency lockfile.

### What to reload or restart

| Change | Service action | Effect |
|---|---|---|
| Client assets | `systemctl --user reload web-terminal` | Serves the new client to browsers on their next page load |
| Web server code | `systemctl --user restart web-terminal` | Browsers reconnect to the running shells |
| Shell host code or configuration | `systemctl --user restart web-terminal-host` | Ends every shell owned by the host |

When upgrading from versions that used account-wide terminal tabs, save work
and close old tabs before deploying. The upgraded app starts with a
session-scoped terminal list. Legacy shells in an existing host remain
running until they exit or the host stops. Existing isolated logins register
their sessions when they reconnect after the session manager upgrade.

## Configuration and security

| Variable | Default | Purpose |
|---|---|---|
| `WEB_TERMINAL_PORT` | `3120` | Loopback HTTP port for the web service |
| `WEB_TERMINAL_MAX` | `8` | Maximum concurrent terminals per session, enforced by the shell host |
| `WEB_TERMINAL_DATA` | `var/` in the checkout | Directory for the private socket and the `secrets/` directory |
| `WEB_TERMINAL_USERNAME` | Prompted interactively | Account name for `npm run passwd` |
| `WEB_TERMINAL_SYSTEM_USER` | Prompted interactively | Optional operating-system user for that account |

For a custom data directory, use the same absolute path for both services
and for `npm run passwd`. Keep the directory private to the service user.
The `secrets/` directory contains the account database, session catalog, and
session signing key. If you change the web port, update the proxy target to
match.

By default, shells run as the service user and start in its home directory
using `$SHELL` or `/bin/bash`. They use `TERM=xterm-256color` and a UTF-8
locale. On Linux, `npm run passwd` can bind an account to another system
user. The host looks up the user with `getent` and starts its login shell
with `sudo -n` when it differs from the service user. The service user needs
the corresponding passwordless sudo permission. Filesystem and process
access follow the permissions of the account’s operating-system user.

Passwords are stored as scrypt hashes. Each account token is signed and
stored in a Secure, HttpOnly cookie with a rolling 90-day lifetime. Changing
a password invalidates that account’s tokens on subsequent API requests and
WebSocket handshakes. An open WebSocket keeps the authorization it received
when it connected until the connection closes.

Login failures are throttled per client address. Behind a loopback proxy the
server uses the last entry in `X-Forwarded-For`, so run it behind a proxy you
control. API writes and WebSocket handshakes validate the origin, and the
page uses Content Security Policy and blocks framing. Run shells with the
least operating-system privilege needed for their work.

## Development

```sh
npm run check             # Type-check the server and client
npm test                  # Run server unit tests
npm run build             # Rebuild client/dist
node tools/test-selection.mjs  # Check the built client with ChromeDriver
```

On this project’s deployment server, use the GitHub Actions artifact for the
client build and keep local checks focused on the affected code. The browser
check runs against an isolated fixture on the Actions runner and uses Chrome
and the matching ChromeDriver.

| Path | Contents |
|---|---|
| `client/` | xterm.js browser UI, tabs, themes, settings, clipboard, and touch input |
| `server/` | Authentication, HTTP and WebSocket API, shell host, and server tests |
| `deploy/` | Example systemd user units and Caddy configuration |
| `tools/` | Browser check and fallback font generation |
| `.github/workflows/build.yml` | Client build, browser check, and artifact upload |

## Fonts and license

The bundled code fonts are JetBrains Mono, Fira Code, Cascadia Code, and
IBM Plex Mono from [Fontsource](https://fontsource.org/), under the SIL Open
Font License. `client/fonts/` holds symbol and icon subsets built by
`tools/subset-fonts.py` from [JuliaMono](https://juliamono.netlify.app/) and
[Nerd Fonts](https://www.nerdfonts.com/). Their licenses are included
alongside the files.

The project is [MIT licensed](LICENSE).
