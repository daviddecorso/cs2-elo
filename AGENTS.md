# Agent Guidelines

## Liquipedia API

This project has free-plan access to the Liquipedia API for the Counter-Strike wiki. Endpoint reference: `docs/liquipedia-api.md`. Any code that fetches or displays Liquipedia data must follow these terms:

- **API key**: Read from `LIQUIPEDIA_API_KEY` in the gitignored `.env`. Use it only in `scripts/`, never in `src/`. Never give it a `VITE_` prefix either, because Vite bundles those variables into the public site. Never commit or log the key.
- **Attribution (CC-BY-SA)**: Credit Liquipedia right next to any data sourced from it, with a backlink to the relevant Liquipedia page where possible. See Liquipedia's Copyrights page for the license terms.
- **API only, never scrape**: Use the documented API endpoints as described in the API documentation. Do not fetch or parse liquipedia.net HTML pages. Scraping gets the IP temporarily and then permanently banned, and revokes API access for good.
- **Open source**: The project must stay published as open source on GitHub. Don't move Liquipedia-dependent code into private repos or closed packages.
- **Verification**: Once a Liquipedia-backed feature is live, the project link has to be sent to Liquipedia so they can verify usage and crediting. Flag this to the user when shipping such a feature.
