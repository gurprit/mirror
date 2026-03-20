# MagicMirror Setup + Central Spotify Auth

A custom MagicMirror setup system with a mobile-friendly settings UI, WiFi onboarding, configurable modules, and a central Spotify auth flow for showing the user’s currently playing track.

## Features

- Mobile-friendly setup page for MagicMirror
- WiFi scan and connect flow
- Weather location settings
- Holiday calendar selection
- Custom calendar feeds
- Custom news feeds with suggested RSS sources
- Custom compliments by time of day
- Traffic module settings
- Spotify "Now Playing" integration
- Central Spotify auth using a Cloudflare Worker
- Per-mirror Spotify login using a generated `mirrorId`
- MagicMirror config generation from saved settings

## Spotify flow

This project uses a central auth server for Spotify instead of local callback URLs on each mirror.

That means the user journey is:

1. Open the mirror settings page
2. Tap **Login to Spotify**
3. Log in on Spotify
4. Approve access
5. Return to the mirror settings page
6. Tap **Refresh Status**
7. Enable the Spotify module and save

This avoids requiring end users to deal with tunnels, redirect URIs, client IDs, or client secrets.

## Project structure

```text
/opt/mm-setup
  ├── data/
  ├── public/
  │   └── index.html
  ├── server.js
  ├── package.json
  └── ...






