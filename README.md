# GodsEar

**GodsEar** is a real-time 3D Globe-to-Street geo-social OSINT visualization engine. Click any street intersection, neighborhood, or coordinate on Earth to see **who posted or tweeted what, when, and where they physically were**.

## Core Capabilities

- **Full-Screen 3D Globe-to-Street Viewport (`100vw × 100vh`)**: Powered by **MapLibre GL v5** (`projection: { type: 'globe' }`) with OpenFreeMap dark vector street tiles, 3D extruded building footprints, and ESRI World Imagery satellite hybrid toggle—zero proprietary map API keys required.
- **100% Real Multi-Platform Feeds (Zero Synthetic Data)**:
  - **iNaturalist**: Real smartphone hardware GPS field observations (`exact_gps`).
  - **Wikimedia Commons**: Real camera EXIF GPS street & landmark photography (`exact_gps`).
  - **Bluesky (`api.bsky.app`)**: Real public ATProto posts anchored to Photon-verified street/venue/neighborhood coordinates.
  - **Reddit Atom RSS**: Real local subreddit & search posts resolved to real street/venue/neighborhood landmarks.
  - **Mastodon**: Real public fediverse statuses anchored to local district/city tags.
  - **X / Twitter**: Pluggable live X API v2 connector (session-ephemeral Bearer token) + drag-and-drop archive importer (`tweets.js`, GeoJSON, JSON, CSV).
- **Coordinate Precision Honesty**: Visually distinguishes hardware-verified **Exact GPS / EXIF pins** (`EXACT GPS`) from Photon-geocoded **Venue / Street / Neighborhood** pins (`VENUE`, `NEIGHBORHOOD`, `CITY`) with zero fake coordinate jitter.
- **Chronological `@handle` Movement Trails**: Click **`Track @handle`** on any post to trace that author's chronological `1 → 2 → 3` path across map stops with total distance traveled.
- **Ephemeral In-Memory LRU Cache**: Swept and imported posts live strictly in bounded server RAM (`EphemeralGeoCache`) and are never written to SQLite or JSON files on disk.

## Quick Start

```bash
pnpm install
pnpm test
pnpm run build
PORT=3012 pnpm start
```

For local hot-reload development:

```bash
pnpm run dev
```

## Documentation

See [docs/architecture.md](docs/architecture.md) for the full Architecture System Diagram (ASD), REST API specification, and upstream provider contract.
