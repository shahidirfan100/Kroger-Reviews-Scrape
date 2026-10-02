# Kroger Reviews API Discovery

## Selected API

- Endpoint: `https://www.kroger.com/atlas/v1/reviews/v1/item/{gtin13}/reviews`
- Method: `GET`
- Request headers: `X-Kroger-Channel: WEB`, `Referer` set to the supplied product URL, and `Accept: application/json, text/plain, */*`
- Query parameters: `page.size=100`, `page.offset`, and `projections=reviews.full`
- Authentication: none required for public review data
- Pagination: `page.offset` is a **zero-based page index** (`0`, `1`, ...) where each page holds `page.size` records. `meta.reviews.totalPages`, `meta.reviews.totalElements`, and `meta.reviews.page.hasMore` describe the set.
- Response path: `data.reviews.product.reviews`
- Output coverage: product URL and GTIN plus the non-empty fields returned on each review

The endpoint returns structured JSON review records and explicit pagination. Impit is used to replay the request with a browser-consistent TLS/HTTP/2 fingerprint and generated browser headers; no browser is launched and no HTML is parsed. The endpoint was independently corroborated by a public Kroger implementation that uses the same Atlas review endpoint.

## Request client

- `impit` (latest, `^0.14.5`) with `browser: 'chrome'`.
- One `Impit` instance is reused for every request so the cookie jar and connection pool are shared.
- No homepage warm-up, cookies, or tokens are required; the endpoint responds to a cold request.
- Proxy support is passed to the `Impit` constructor as `proxyUrl` when Apify Proxy or custom proxies are configured.

## Header requirements (directly tested)

| Request profile                           | Result                |
| ----------------------------------------- | --------------------- |
| No extra headers                          | HTTP 200, review data |
| Only `X-Kroger-Channel: WEB`              | HTTP 200, review data |
| Only `Referer`                            | HTTP 200, review data |
| Full headers (channel + referer + accept) | HTTP 200, review data |

The endpoint does not require the channel or referer headers, but the actor keeps the documented `X-Kroger-Channel` and product `Referer` values because they match the known working flow and are harmless.

## Browser-profile comparison

`impit` profiles were tested directly against `item/0001111050315/reviews`.

| Profile                    | Result                           |
| -------------------------- | -------------------------------- |
| `chrome`                   | HTTP 200, review data (selected) |
| `chrome131`                | HTTP 200, review data            |
| `chrome142`                | HTTP 200, review data            |
| `chrome151`                | HTTP 200, review data            |
| `firefox144`               | HTTP 200, review data            |
| `ios18`                    | HTTP 200, review data            |
| `okhttp5`                  | error, no data                   |
| No emulation (plain fetch) | request timeout, blocked         |

`chrome` is selected because it matches the browser flow used for discovery, is the Impit default, and passed repeated reliability checks (8/8 and 6/6 consecutive requests). Every Chrome-family and Firefox profile tested behaved identically, so no target-specific override is needed.

## Pagination and server-side flakiness

- `page.offset` is a zero-based page index and `page.size` sets records per page. `meta.reviews.totalPages` drives the stop condition alongside `hasMore` and a short page.
- `page.size=100` is the largest value that returns reliably. The production reviews service resolves each page through a downstream call that hard-times-out at 1000 ms, so larger page sizes (110+ records actually returned) begin failing with `timeout of 1000ms exceeded`. Requesting 100 records per page therefore covers more products in a single request while remaining inside the service budget.
- The Atlas backend intermittently returns HTTP 500 for any page, including the first, with bodies such as:
    - `{"errors":{"reason":"timeout of 1000ms exceeded","code":"httpClient:ECONNABORTED"}}`
    - `{"errors":{"reason":"Open Circuit: reviews::getReviews","code":"OPENBREAKER"}}`
- The failure is a global backend circuit breaker, not a request-profile problem: once one request fails, unrelated products in the same run return `Open Circuit` too. Recovery is inconsistent and was observed to take from a few seconds to several minutes. Different `impit` profiles and different page sizes all fail together during an outage.
- This was tested across many real product URLs (`0001111050315`, `0000000004011`, `0001111041700`, `0001111010014`, `0001111063259`, `0001111091649`, and others). Products with 0 reviews return HTTP 200 with an empty `reviews` array, so empty and unavailable are distinguished correctly.
- Because of this, the actor:
    - requests 100 records per page to minimise the number of calls;
    - retries 408/425/429/5xx responses up to five times with exponential backoff, jitter, and `Retry-After` support;
    - skips a product with a warning if its first page cannot be fetched;
    - keeps the reviews already collected and stops pagination for a product if a later page cannot be fetched, instead of failing the whole run.

## Candidate matrix

| Candidate | Client profile | Status/body | Fields | Pagination | Decision |
|---|---|---|---|---:|---|---|
| Kroger Atlas reviews | `impit` `chrome` | JSON review payload | Rich review object with rating, text, votes, timestamps, identifiers, and flags | `page.size`, zero-based `page.offset`, `totalPages`/`hasMore` | Selected |
| Kroger Atlas reviews | Patched headful Chrome (previous version) | JSON when it worked, but headful browser runtime was fragile and slow | Same | Same | Replaced by `impit` |
| No-emulation HTTP | plain fetch | request timeout / blocked | Not usable | Not applicable | Rejected |
| `okhttp5` emulation | `impit` `okhttp5` | error, no payload | Not usable | Not applicable | Rejected |
| Kroger product page | browser navigation | HTTP 403 in local environment | Not usable without rendering | Not applicable | Rejected for extraction |
| Kroger public Products API | OAuth API | Requires application authorization | Product catalog, not product reviews | Catalog pagination | Rejected |
| Generic Bazaarvoice Conversations API | passkey-based | Requires retailer/client passkey | Review data when authorized | `Limit`/`Offset` | Rejected because it adds an external credential requirement |
| HTML/JSON-LD fallback | page response | Blocked in local environment | Product markup only, not the complete review set | Not reliable | Rejected |

## Selection score

The Atlas endpoint scores above the updater threshold: direct JSON (+30), rich review objects (+25), no application credential observed (+20), pagination (+15), and exact match to the requested review data (+10). The actor therefore stays API-based and does not parse HTML.

## Resilience notes

- `impit` supplies the browser-consistent request profile; no browser is installed or launched.
- The actor overrides only Kroger-specific request headers and lets Impit generate fingerprint headers.
- Each product is fetched in pages of up to 100 reviews, the largest reliably served page size.
- HTTP 500, 429, 408, 425, and 5xx responses receive up to five bounded retries with exponential backoff, jitter, and `Retry-After` support; permanent 4xx responses are not retried.
- A failed later page stops pagination for that product but keeps already-collected reviews; a failed first page skips only that product.
- Missing or changed response keys produce a warning and stop that product cleanly instead of creating empty records.
- Null, blank, empty-array, and empty-object values are removed recursively before dataset writes.
- Zero matching reviews from valid products is reported as a warning with a successful run, not a hard failure.
