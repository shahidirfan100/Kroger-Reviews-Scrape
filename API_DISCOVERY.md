# Kroger Reviews API Discovery

## Selected API

- Endpoint: `https://www.kroger.com/atlas/v1/reviews/v1/item/{gtin13}/reviews`
- Method: `GET`
- Required request header: `X-Kroger-Channel: WEB`
- Context header: `Referer` set to the supplied product URL
- Query parameters: `page.size`, `page.offset`, and `projections=reviews.full`
- Authentication: None observed for public review data
- Pagination: 64-record pages using a zero-based page-index `page.offset` (`0`, `1`, ...); `meta.reviews.page.hasMore` indicates continuation
- Response path: `data.reviews.product.reviews`
- Output coverage: product URL and GTIN plus the non-empty fields returned on each review

The endpoint was selected because it returns structured JSON review records and explicit pagination. Patchright Chrome now fetches this endpoint directly from an in-origin browser request; the product page is never navigated for extraction and no HTML is parsed. The API request pattern and response shape were independently corroborated by a public Kroger implementation that uses the same Atlas review endpoint.

## Candidate matrix

| Candidate | Header profile | Status/body | Fields | Pagination | Decision |
|---|---|---:|---:|---|---|
| Kroger Atlas reviews | Same-origin browser API request | JSON review payload | Rich review object with rating, text, votes, timestamps, identifiers, and flags | `page.size`, zero-based `page.offset`, `hasMore` | Selected |
| Kroger product page | Browser navigation | HTTP 403 in local browser | Not usable without rendering | Not applicable | Rejected for extraction |
| Kroger public Products API | OAuth API | Requires application authorization | Product catalog, not product reviews | Catalog pagination | Rejected |
| Generic Bazaarvoice Conversations API | Passkey-based | Requires retailer/client passkey | Review data when authorized | `Limit`/`Offset` | Rejected because it adds an external credential requirement |
| HTML/JSON-LD fallback | Page response | Blocked in local environment | Product markup only, not the complete review set | Not reliable | Rejected |

## Selection score

The Atlas endpoint scores above the updater threshold: direct JSON (+30), rich review objects (+25), no application credential observed (+20), pagination (+15), and exact match to the requested review data (+10). The actor therefore stays API-based and does not parse HTML.

## Resilience notes

- Patchright Chrome supplies the browser-consistent request profile and API-only browser transport.
- The actor sends only the Kroger-specific channel and product referer headers; it does not override browser fingerprint headers.
- HTTP 403, 429, and 5xx responses receive bounded retries with backoff.
- Missing or changed response keys produce a warning and stop that product cleanly instead of creating empty records.
- Null, blank, empty-array, and empty-object values are removed recursively before dataset writes.
