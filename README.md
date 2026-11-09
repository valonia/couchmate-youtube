# YouTube – a Couchmate plugin

YouTube videos, channels and playlists, played in sync for everyone – in up to 1080p or as audio only, without ads. Sponsor segments are skipped with SponsorBlock.

**Requires:** Internet access from the server. The plugin downloads yt-dlp by itself and keeps it up to date. No YouTube account needed.

## Install

Couchmate servers ship with this plugin: in the admin panel, open **Plugins** and press **Install** next to it.

To install it by hand, download the latest release as a zip (**Releases → Source code (zip)**) and upload it under
**Plugins → Upload plugin (.zip)**.

## Updates

The server checks this repository for new releases every 6 hours. Under **Plugins** you can update with one
click, or switch on **Update automatically** to have new versions installed as soon as they are released.

To release a new version: raise `version` in `plugin.json`, commit, and publish a GitHub release tagged
`v<version>` (e.g. `v1.1.0`).

## Settings

- **Topics on the front page** – A row of videos for each search, separated by commas, e.g. "Avicii, Swedish news, Minecraft".
- **Channels on the front page** – Channels separated by commas: @name or a youtube.com link. Each gets a row with its latest videos.
- **Playlists on the front page** – Playlist links separated by commas. Each gets a row; the videos play one after another.
- **Default quality** – Can be changed in the player's settings while watching.
- **Autoplay** – When a single video ends, similar videos follow (YouTube's Mix for it). They show in the queue (arrow up in the player).
- **Skip sponsor segments (SponsorBlock)** – Segments marked by SponsorBlock's users are skipped for everyone.
- **SponsorBlock: what to skip** – sponsor, selfpromo, interaction ("like and subscribe"), intro, outro, preview, music_offtopic (non-music in music videos).

## Making your own

Plugins are plain JavaScript modules – `index.mjs` here is a working example to start from.
