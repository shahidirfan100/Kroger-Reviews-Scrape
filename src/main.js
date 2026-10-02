import { Actor, log } from 'apify';
import { Dataset } from 'crawlee';
import { Impit } from 'impit';

const PAGE_SIZE = 64;
const MAX_RETRIES = 4;
const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 8_000;
const BROWSER_PROFILE = 'chrome';
const REVIEWS_HOST = 'https://www.kroger.com';

function getUrlValue(urlItem) {
    return typeof urlItem === 'string' ? urlItem : urlItem?.url;
}

function getProductId(productUrl) {
    let parsedUrl;
    try {
        parsedUrl = new URL(productUrl);
    } catch {
        return null;
    }

    if (!/(^|\.)kroger\.com$/i.test(parsedUrl.hostname)) return null;

    const pathParts = parsedUrl.pathname.split('/').filter(Boolean);
    const productId =
        pathParts.at(-1)?.match(/^(\d{8,14})(?:\D|$)/)?.[1] || pathParts.find((part) => /^\d{8,14}$/.test(part));

    return productId ? { productId, canonicalUrl: parsedUrl.href } : null;
}

function cleanValue(value) {
    if (value === null || value === undefined) return undefined;
    if (typeof value === 'string' && value.trim() === '') return undefined;

    if (Array.isArray(value)) {
        const cleaned = value.map(cleanValue).filter((item) => item !== undefined);
        return cleaned.length ? cleaned : undefined;
    }

    if (typeof value === 'object') {
        const cleaned = Object.fromEntries(
            Object.entries(value)
                .filter(([key]) => !key.startsWith('_'))
                .map(([key, item]) => [key, cleanValue(item)])
                .filter(([, item]) => item !== undefined),
        );
        return Object.keys(cleaned).length ? cleaned : undefined;
    }

    return value;
}

function cleanReview(review, productUrl, productId) {
    const record = cleanValue({
        ...review,
        productLink: productUrl,
        gtin13: productId,
    });

    return record && typeof record === 'object' ? record : null;
}

function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

function describeError(error) {
    return String(error?.message || error).split(/\r?\n/, 1)[0];
}

function isRetryableStatus(status) {
    return status === 408 || status === 425 || status === 429 || status >= 500;
}

function extractErrorMessage(body, status) {
    try {
        const parsed = JSON.parse(body);
        const reason = parsed?.errors?.reason ?? parsed?.error ?? parsed?.message;
        if (typeof reason === 'string' && reason.trim()) return `${reason} (HTTP ${status})`;
    } catch {
        // Non-JSON error bodies fall back to the status code below.
    }
    return `HTTP ${status}`;
}

function createApiClient(proxyUrl) {
    return new Impit({
        browser: BROWSER_PROFILE,
        timeout: REQUEST_TIMEOUT_MS,
        ...(proxyUrl ? { proxyUrl } : {}),
    });
}

async function requestPage(client, { productId, referer, offset }) {
    const apiUrl = new URL(`${REVIEWS_HOST}/atlas/v1/reviews/v1/item/${productId}/reviews`);
    apiUrl.searchParams.set('page.size', String(PAGE_SIZE));
    apiUrl.searchParams.set('page.offset', String(offset));
    apiUrl.searchParams.set('projections', 'reviews.full');

    let lastError;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const response = await client.fetch(apiUrl.href, {
                headers: {
                    'X-Kroger-Channel': 'WEB',
                    Referer: referer,
                    Accept: 'application/json, text/plain, */*',
                },
            });
            const { status } = response;
            const body = await response.text();
            if (status >= 200 && status < 300) {
                try {
                    return JSON.parse(body);
                } catch {
                    throw new Error(`Received a non-JSON response (HTTP ${status})`);
                }
            }

            const message = extractErrorMessage(body, status);
            if (!isRetryableStatus(status)) {
                const error = new Error(message);
                error.retryable = false;
                throw error;
            }
            lastError = new Error(message);
        } catch (error) {
            if (error.retryable === false) throw error;
            lastError = error;
        }

        if (attempt < MAX_RETRIES) {
            const waitMs =
                Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), RETRY_MAX_DELAY_MS) +
                Math.floor(Math.random() * 400);
            log.warning(
                `Kroger reviews request failed for ${productId} page ${offset} (${describeError(lastError)}); ` +
                    `retrying ${attempt}/${MAX_RETRIES - 1} in ${waitMs} ms`,
            );
            await sleep(waitMs);
        }
    }

    throw lastError;
}

async function fetchReviews({ client, productUrl, productId, resultsWanted, maxPages, keywordReview }) {
    const reviews = [];
    const seen = new Set();
    let fetchedAnyPage = false;

    for (let offset = 0; offset < maxPages && reviews.length < resultsWanted; offset++) {
        let payload;
        try {
            payload = await requestPage(client, { productId, referer: productUrl, offset });
            fetchedAnyPage = true;
        } catch (error) {
            const reason = describeError(error);
            if (offset === 0) {
                log.warning(
                    `Could not fetch the first review page for ${productId} (${reason}); skipping this product`,
                );
            } else {
                log.warning(
                    `Stopping pagination for ${productId} at page ${offset} after repeated errors (${reason}); ` +
                        `keeping ${reviews.length} review(s) already collected`,
                );
            }
            break;
        }

        const pageReviews = payload?.data?.reviews?.product?.reviews;
        if (!Array.isArray(pageReviews)) {
            log.warning(`Unexpected review response shape for ${productId} page ${offset}; stopping this product`);
            break;
        }

        for (const review of pageReviews) {
            const reviewText = String(review?.reviewText ?? '');
            if (keywordReview && !reviewText.toLowerCase().includes(keywordReview)) continue;

            const record = cleanReview(review, productUrl, productId);
            if (!record) continue;

            const key = review?.id ?? review?.reviewId ?? review?.submissionId ?? JSON.stringify(record);
            if (seen.has(key)) continue;
            seen.add(key);
            reviews.push(record);

            if (reviews.length >= resultsWanted) break;
        }

        const hasMore = payload?.meta?.reviews?.page?.hasMore;
        const totalPages = Number(payload?.meta?.reviews?.totalPages);
        const reachedLastPage =
            pageReviews.length < PAGE_SIZE ||
            hasMore === false ||
            (Number.isFinite(totalPages) && offset + 1 >= totalPages);

        if (!pageReviews.length || reachedLastPage) break;
    }

    return { reviews, fetchedAnyPage };
}

await Actor.init();

let exitCode = 0;

try {
    const input = (await Actor.getInput()) || {};
    const {
        startUrls = [],
        keywordReview = '',
        results_wanted: resultsWantedRaw = 20,
        max_pages: maxPagesRaw = 10,
        proxyConfiguration,
    } = input;

    const resultsWanted = Number.isFinite(Number(resultsWantedRaw))
        ? Math.max(1, Math.floor(Number(resultsWantedRaw)))
        : 20;
    const maxPages = Number.isFinite(Number(maxPagesRaw)) ? Math.max(1, Math.floor(Number(maxPagesRaw))) : 10;

    if (!Array.isArray(startUrls) || startUrls.length === 0) {
        throw new Error('Provide at least one Kroger product URL in startUrls.');
    }

    const productUrls = startUrls.map(getUrlValue).filter(Boolean);
    const proxyEnabled = Boolean(proxyConfiguration?.useApifyProxy);
    const customProxyUrls = Array.isArray(proxyConfiguration?.proxyUrls) && proxyConfiguration.proxyUrls.length > 0;
    const useProxy = proxyEnabled || customProxyUrls;

    let proxyUrl;
    if (useProxy && Actor.isAtHome()) {
        const proxyConfig = await Actor.createProxyConfiguration({ ...proxyConfiguration });
        proxyUrl = proxyConfig ? await proxyConfig.newUrl() : undefined;
    } else if (useProxy) {
        log.info('Skipping Apify Proxy for local execution.');
    }

    const client = createApiClient(proxyUrl);
    const keyword = String(keywordReview || '').trim();

    log.info(
        `Starting Kroger review extraction | urls=${productUrls.length} | target=${resultsWanted} | max_pages=${maxPages}`,
    );

    let totalSaved = 0;
    let fetchedProducts = 0;

    for (const productUrl of productUrls) {
        if (totalSaved >= resultsWanted) break;

        const product = getProductId(productUrl);
        if (!product) {
            log.warning(`Skipping unsupported Kroger product URL: ${productUrl}`);
            continue;
        }

        const { reviews: batch, fetchedAnyPage } = await fetchReviews({
            client,
            productUrl: product.canonicalUrl,
            productId: product.productId,
            resultsWanted: resultsWanted - totalSaved,
            maxPages,
            keywordReview: keyword,
        });

        if (fetchedAnyPage) fetchedProducts++;

        if (batch.length) {
            await Dataset.pushData(batch);
            totalSaved += batch.length;
            log.info(`Saved ${batch.length} reviews for ${product.productId}; total=${totalSaved}/${resultsWanted}`);
        } else {
            log.warning(`No matching reviews found for ${product.productId}`);
        }
    }

    if (totalSaved === 0 && fetchedProducts === 0) {
        throw new Error('Kroger review data could not be fetched for any supplied product URL.');
    }

    if (totalSaved === 0) {
        log.warning(
            'No reviews matched the supplied product URLs and filters. ' +
                'The products may have no public reviews or the keyword filter may be too strict.',
        );
    }

    log.info(`Finished | saved=${totalSaved} | requested=${resultsWanted}`);
} catch (error) {
    exitCode = 1;
    log.error(`Actor failed: ${describeError(error)}`);
} finally {
    await Actor.exit({ exitCode });
}
