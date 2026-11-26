# Brutti Hub Data

Public data for the [Brutti AI Marketing Hub](https://brutti-team.github.io/brutti-ai-marketing-hub/). Anyone can read these files. There are no passwords, API tokens, or private keys in this repository.

## Files

| Path | What it is |
| --- | --- |
| `meta/posts-recent.json` | Facebook and Instagram post metrics from the last 400 days (trimmed captions, no image URLs). Used by the dashboard. |
| `meta/posts-archive-YYYY.json` | Older posts, one file per year (2020–2025). |
| `meta/style-library.json` | A small set of top captions used to understand Brutti’s writing style. |
| `meta/status.json` | Last sync time and post counts. Does not include token details. |
| `products.json` | Product library (names, details, prices, and image paths). |
| `kol.json` | KOL Sabah directory, including contact numbers and rates. |
| `marketing-tools.json` | Marketing campaigns (bunting, billboard, KOL). |
| `planner.json` | One-time starter notes for the Calendar Planner. New notes are saved on each device only, not back to this repo. |
| `content.json` | One-time starter caption drafts. New drafts are saved on each device only. |
| `images/products/` | Product photos that were previously on Google Drive. |
| `images/assets/` | Confirmed product photos from the Drive asset folder. |
| `images/marketing/` | Campaign images. |

Meta post data is updated from Facebook and Instagram. A scheduled GitHub Action will be added later; it is not in this repository yet.

Do not commit secrets, access tokens, or the `_raw/` export folder.

## Automatic Meta sync

`.github/workflows/meta-sync.yml` runs every 6 hours (and on demand from the Actions tab).
It calls `scripts/sync-meta.mjs`, which reads Facebook and Instagram posts and insights
from the Meta Graph API (read-only, it never publishes) and updates `meta/posts-recent.json`,
the yearly archives, `meta/style-library.json` and `meta/status.json`. It commits only when
the data changed. `status.json` shows only `tokenStatus` (`valid` / `expired` / `error`).

Required repository secrets (Settings → Secrets and variables → Actions):
`META_PAGE_ACCESS_TOKEN`, `META_PAGE_ID`, `META_INSTAGRAM_USER_ID`, and optional `META_GRAPH_VERSION` (defaults to `v23.0`).

Local dry run with mocked Graph responses (no token, writes nothing):

```
DRY_RUN=1 MOCK_GRAPH=scripts/fixtures/mock-graph.json META_PAGE_ID=PAGE META_INSTAGRAM_USER_ID=IG node scripts/sync-meta.mjs
```
