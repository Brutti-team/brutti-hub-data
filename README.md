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
