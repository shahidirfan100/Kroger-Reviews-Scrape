# Kroger Reviews API Discovery

## Selected API

- Endpoint: `https://www.kroger.com/atlas/v1/reviews/v1/item/{gtin13}/reviews`
- Method: `GET`
- Request headers: `X-Kroger-Channel: WEB`, `Referer` set to the supplied product URL, and `Accept: application/json, text/plain, */*`
- Query parameters: `page.size=64`, `page.offset`, and `projections=reviews.full`
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

| Request profile                           | Result               |
| ----------------------------------------- | -------------------- |
| No extra headers                          | HTTP 200, 64 reviews |
| Only `X-Kroger-Channel: WEB`              | HTTP 200, 64 reviews |
| Only `Referer`                            | HTTP 200, 64 reviews |
| Full headers (channel + referer + accept) | HTTP 200, 64 reviews |

The endpoint does not require the channel or referer headers, but the actor keeps the documented `X-Kroger-Channel` and product `Referer` values because they match the known working flow and are harmless.

## Browser-profile comparison

Every profile supported by the installed `impit` version was tested directly against
`item/0001111050315/reviews` (two consecutive requests each).

| Profile                                                                  | Result                |
| ------------------------------------------------------------------------ | --------------------- |
| `chrome`, `chrome100`, `chrome101`, `chrome104`, `chrome107`, `chrome110` | HTTP 200, 32 reviews  |
| `chrome116`, `chrome124`, `chrome125`, `chrome131`, `chrome136`, `chrome142`, `chrome151` | HTTP 200, 32 reviews |
| `firefox`, `firefox128`, `firefox133`, `firefox135`, `firefox144`        | HTTP 200, 32 reviews  |
| `ios18`                                                                  | HTTP 200, 32 reviews  |
| `okhttp`, `okhttp3`, `okhttp4`, `okhttp5`                                | request error, no data |
| No emulation (plain fetch)                                               | request timeout, blocked |

Every Chrome-family, Firefox-family, and iOS profile behaves identically and reliably. Only the
`okhttp*` profiles fail, so they are excluded. `chrome` is the primary profile; the actor rotates
across `chrome`, `chrome131`, `firefox144`, `ios18`, and `chrome142` when a request has to be retried,
which gives each retry a fresh, browser-consistent TLS/HTTP fingerprint.

## Pagination and server-side flakiness

- `meta.reviews.totalPages` drives the stop condition alongside `hasMore` and a short page.
- The Atlas backend intermittently fails individual pages with HTTP 500 bodies such as:
    - `{"errors":{"reason":"timeout of 1000ms exceeded","code":"httpClient:ECONNABORTED"}}`
    - `{"errors":{"reason":"Open Circuit: reviews::getReviews","code":"OPENBREAKER"}}`
- These failures were reproduced across different products and page offsets, including cases where `page.offset=0` and `page.offset=2` succeed while `page.offset=1` fails repeatedly. The failure is in Kroger's own reviews service, not in the request profile: all tested profiles behaved the same way.
- The failures arrive in short clusters. During one cluster `page.size=16/40/48/50/64` failed repeatedly while `page.size=20/24/32` succeeded; minutes later every size returned HTTP 200. The failure is therefore transient and partly keyed to the exact request URL, not to the client or headers.
- Because of this, the actor combines several bounded recovery strategies:
    - Each request is retried with exponential backoff and jitter, and rotates the browser profile on every attempt so a fresh fingerprint is used.
    - `Retry-After` is honored for `429`/`503` responses and capped, and permanent `4xx` responses are never retried.
    - The first page of a product is requested with `page.size=64` and, if it keeps failing, falls back to `page.size=32`, then `24`, then `20`; the size that succeeds is reused for the remaining pages of that product so offset pagination stays aligned.
    - If a product's first page still fails, the product is deferred and retried once more after all other products, with a larger attempt budget. This rides out a failure cluster instead of dropping the product.
    - if the first page fails even after recovery, it skips that product with a warning and continues;
    - if a later page fails, it keeps the reviews already collected and stops pagination for that product instead of failing the whole run.

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
- One Impit client is reused per browser profile; profiles are rotated only between retry attempts.
- HTTP 500, 429, 408, 425, and 5xx responses receive bounded retries with backoff and jitter; permanent 4xx responses are not retried.
- The first page falls back through `page.size=64 → 32 → 24 → 20`; the size that works is locked for the product.
- A product whose first page fails is deferred and retried once more after other products before it is dropped.
- A failed later page stops pagination for that product but keeps already-collected reviews; a failed first page skips only that product.
- Response keys are resolved case-insensitively and validated before use; missing or changed keys produce a warning and stop that product cleanly instead of creating empty records.
- Null, blank, empty-array, and empty-object values are removed recursively before dataset writes.
- Zero matching reviews from valid products is reported as a warning with a successful run, not a hard failure.
