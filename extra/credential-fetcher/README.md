# credential-fetcher

A tiny electron app for obtaining necessary credentials from YouTube.

## Usage

```
npm start
```

After a successful login, the base64-encoded credential token will be appeared on the terminal.

By default the token omits short-lived cookies (`*PSIDTS`, `*PSIDCC`) so a snapshot stays usable longer. Pass `--full` to include them:

```
npx electron . --full
```
