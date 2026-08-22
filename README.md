## What does Kroger Reviews Scraper do?

Kroger Reviews Scraper collects public customer reviews from Kroger product pages and returns clean, structured review data for product research, sentiment analysis, quality monitoring, and competitive intelligence. Add one or more Kroger product URLs, choose the review limit, and download a dataset containing review text, ratings, recommendation signals, engagement counts, reviewer nicknames, timestamps, and the product GTIN-13.

## Why use Kroger Reviews Scraper?

- **Product feedback at scale** - Collect many reviews without manually opening each product page.
- **Useful review context** - Keep ratings, headlines, full text, recommendation signals, votes, dates, and product identifiers together.
- **Clean output** - Empty and unavailable values are omitted from records instead of being stored as repeated null fields.
- **Flexible collection** - Process multiple product URLs, cap the total results, limit review pages, and optionally filter review text by keyword.
- **Automation-ready data** - Export JSON, CSV, Excel, XML, or connect the dataset to downstream workflows through Apify.

## What data can you extract from Kroger reviews?

| Field | Description |
|-------|-------------|
| `productLink` | Kroger product URL supplied for the review collection. |
| `gtin13` | Product barcode extracted from the URL. |
| `reviewId` | Review identifier when published by Kroger. |
| `submissionId` | Review submission identifier when available. |
| `title` | Review headline. |
| `reviewText` | Full customer review content. |
| `rating` | Star rating value. |
| `recommended` | Whether the reviewer recommends the product. |
| `helpfulVoteCount` | Helpful vote count. |
| `notHelpfulVoteCount` | Not-helpful vote count. |
| `userNickname` | Public reviewer nickname when available. |
| `syndicated` | Whether the review is marked as syndicated. |
| `featured` | Whether the review is marked as featured. |
| `ratingsOnly` | Whether the record contains a rating without written content. |
| `submissionTime` | Review submission timestamp object. |
| `lastModificationTime` | Last modification timestamp object. |
| `client` | Source client label when available. |

## How to use Kroger Reviews Scraper

1. Open the Actor in Apify Console.
2. Add one or more public Kroger product URLs.
3. Set `results_wanted` and `max_pages` for the amount of review data you need.
4. Run the Actor.
5. Preview the dataset, download it, or connect it to an automation.

## Input Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `startUrls` | Array | Yes | Prefilled example URL | One or more Kroger product URLs, including URLs with fulfillment query parameters. |
| `results_wanted` | Integer | No | `20` | Maximum number of reviews saved across all supplied products. |
| `max_pages` | Integer | No | `10` | Maximum number of 64-review pages requested per product. |
| `keywordReview` | String | No | Empty | Optional case-insensitive filter applied to `reviewText`. |
| `proxyConfiguration` | Object | No | Apify Proxy enabled on cloud runs | Proxy settings for reliable scheduled or larger runs. |

## Usage Examples

### Basic product review collection

Collect the first 20 reviews from the supplied Kroger product:

```json
{
  "startUrls": [
    "https://www.kroger.com/p/kroger-heavy-whipping-cream-pint/0001111050315"
  ],
  "results_wanted": 20
}
```

### Multiple products with pagination

Collect up to 100 reviews across two product URLs, with a page safety cap:

```json
{
  "startUrls": [
    "https://www.kroger.com/p/kroger-heavy-whipping-cream-pint/0001111050315?fulfillment=PICKUP",
    "https://www.kroger.com/p/fresh-banana-single/0000000004011?fulfillment=PICKUP"
  ],
  "results_wanted": 100,
  "max_pages": 3
}
```

### Keyword-filtered review monitoring

Keep only reviews whose text mentions freshness:

```json
{
  "startUrls": [
    "https://www.kroger.com/p/kroger-heavy-whipping-cream-pint/0001111050315"
  ],
  "results_wanted": 50,
  "max_pages": 5,
  "keywordReview": "fresh"
}
```

## Sample Output

Each dataset item represents one review. Fields that are not published for a particular review are omitted.

```json
{
  "productLink": "https://www.kroger.com/p/kroger-heavy-whipping-cream-pint/0001111050315",
  "gtin13": "0001111050315",
  "title": "Great for baking",
  "reviewText": "This cream whips well and works for desserts.",
  "rating": 5,
  "recommended": true,
  "helpfulVoteCount": 2,
  "notHelpfulVoteCount": 0,
  "userNickname": "Anonymous",
  "syndicated": false,
  "submissionTime": {
    "timezone": "America/New_York",
    "value": "2026-01-15T16:30:41.000Z"
  }
}
```

## Tips for Best Results

- Use complete public Kroger product URLs that contain the product barcode.
- Query parameters such as `fulfillment=PICKUP` are accepted and retained in `productLink`.
- Start with `results_wanted: 20` to verify the product before requesting more pages.
- Increase `max_pages` when a product has a large review history.
- Some products have few or no public reviews, and some reviewers are shown as anonymous.
- Use Apify Proxy for larger, scheduled, or repeated runs.

## Integrations

- **Google Sheets and Excel** - Review feedback in a familiar table format.
- **Make, Zapier, and n8n** - Trigger actions from completed runs.
- **Webhooks** - Notify a service when a dataset is ready.
- **Apify API** - Start runs, retrieve datasets, and schedule recurring collection.
- **JSON, CSV, XML, and Excel exports** - Use the format that fits your analysis workflow.

## Frequently Asked Questions

### Can I provide more than one Kroger product URL?

Yes. Add multiple URL strings to `startUrls`. `results_wanted` limits the total number of saved reviews for the run.

### Do product URLs with fulfillment parameters work?

Yes. URLs containing parameters such as `fulfillment=PICKUP`, `fulfillment=DELIVERY`, or `fulfillment=SHIP` are accepted as long as the URL contains a Kroger product barcode.

### Why is a field missing from one review?

Kroger does not publish every field for every review. The Actor omits unavailable values so the dataset stays compact and avoids repeated null fields.

### Can I filter reviews by a word or phrase?

Yes. Set `keywordReview` to a case-insensitive phrase that must appear in `reviewText`.

### Does the Actor support pagination?

Yes. It requests review pages until the result limit, `max_pages`, or the source pagination signal stops the run.

### Can I export Kroger review data to CSV or Excel?

Yes. Apify datasets can be downloaded as JSON, CSV, Excel, XML, and other supported formats.

### Is collecting Kroger reviews legal?

Public data collection may be subject to website terms, applicable law, and privacy requirements. Use the Actor responsibly, respect Kroger policies, and collect only data you are permitted to use.

## Related Actors

- [Target Reviews Scraper](https://apify.com/shahidirfan/target-reviews-scraper) - Collect structured customer reviews from Target product pages.
- [Walmart Reviews Scraper](https://apify.com/shahidirfan/walmart-reviews-scraper) - Collect ratings, review text, reviewer details, and product-level feedback from Walmart.
- [iHerb Reviews Scraper](https://apify.com/shahidirfan/iherb-reviews-scraper) - Extract reviews and ratings from iHerb product pages for health and wellness product research.

## Support

For issues, feature requests, or custom Actor work, use the Issues tab on the Actor page or contact the developer through Apify.

## Legal Notice

This Actor is designed for legitimate collection of publicly available review data. You are responsible for complying with Kroger's terms, applicable laws, privacy rules, and any restrictions on storing or redistributing the collected data.
