# Otaku News: Verified Where to Watch Finder

This update keeps every existing AniList **Where to Watch** button exactly as it is. The new button only **adds extra providers** that are returned by the server-side verified watch-provider lookup.

## What it does

- Keeps existing AniList streaming links
- Lets the visitor choose a country
- Finds additional regional providers
- Classifies providers as Subscription, Free, Free with Ads, Rent, or Buy
- Never removes an existing button
- Never scrapes pirate sites
- Keeps the TMDB API token on the server, not in the browser

## One-time Firebase setup

The project already has a Cloud Functions file. Put `index.js` inside your Firebase Functions source folder if your deployment uses `functions/index.js`.

Install/configure the TMDB secret:

```bash
firebase functions:secrets:set TMDB_API_READ_TOKEN
```

Use a TMDB API Read Access Token for that secret, then deploy:

```bash
firebase deploy --only functions
```

The page is already configured to call:

```text
https://us-central1-otaku-news-1062.cloudfunctions.net/watchProviders
```

If Firebase gives your deployed function a different URL, set this before the anime page script runs:

```html
<script>
  window.OTAKU_WATCH_FINDER_URL = "YOUR_FUNCTION_URL";
</script>
```

## Important

TMDB's watch-provider response is regional. A service found in India may not be available in the US, and vice versa. If no additional provider is found, the existing AniList buttons remain untouched.
