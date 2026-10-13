import { Actor, log } from 'apify';
import { Dataset } from 'crawlee';
import { Impit } from 'impit';

const PAGE_SIZE = 64;
const PAGE_SIZE_FALLBACKS = [32, 24, 20];
const MAX_ATTEMPTS = 6;
const RECOVERY_MAX_ATTEMPTS = 10;
const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_BASE_DELAY_MS = 800;
const RETRY_MAX_DELAY_MS = 5_000;
const RETRY_AFTER_CAP_MS = 10_000;
const PRODUCT_RECOVERY_DELAY_MS = 3_000;
const BROWSER_PROFILES = ['chrome', 'chrome131', 'firefox144', 'ios18', 'chrome142'];
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

function getKeyInsensitive(object, key) {
    if (!object || typeof object !== 'object') return undefined;
    if (key in object) return object[key];

    const lower = key.toLowerCase();
    const match = Object.keys(object).find((candidate) => candidate.toLowerCase() === lower);
    return match === undefined ? undefined : object[match];
}

function extractReviews(payload) {
    const data = getKeyInsensitive(payload, 'data');
    const reviews = getKeyInsensitive(data, 'reviews');
    const product = getKeyInsensitive(reviews, 'product');
    const list = getKeyInsensitive(product, 'reviews');
    return Array.isArray(list) ? list : null;
}

function extractMeta(payload) {
    const reviewsMeta = getKeyInsensitive(getKeyInsensitive(payload, 'meta'), 'reviews');
    const page = getKeyInsensitive(reviewsMeta, 'page');
    return {
        hasMore: getKeyInsensitive(page, 'hasMore'),
        totalPages: Number(getKeyInsensitive(reviewsMeta, 'totalPages')),
    };
}

function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

function describeError(error) {
    const message = String(error?.message || error).replace(/\s+/g, ' ').trim();
    return message.length > 160 ? `${message.slice(0, 157)}...` : message;
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

function getRetryAfterMs(response) {
    const header = response?.headers?.get?.('retry-after');
    if (!header) return null;

    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, RETRY_AFTER_CAP_MS);

    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.min(Math.max(date - Date.now(), 0), RETRY_AFTER_CAP_MS);
    return null;
}

function computeBackoffMs(attempt, retryAfterMs) {
    if (retryAfterMs !== null) return retryAfterMs;
    const base = Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), RETRY_MAX_DELAY_MS);
    return base + Math.floor(Math.random() * 500);
}

function createClientPool(proxyUrl) {
    const clients = new Map();
    return {
        get(profile) {
            if (!clients.has(profile)) {
                clients.set(
                    profile,
                    new Impit({
                        browser: profile,
                        timeout: REQUEST_TIMEOUT_MS,
                        ...(proxyUrl ? { proxyUrl } : {}),
                    }),
                );
            }
            return clients.get(profile);
        },
    };
}

async function requestPage({ pool, productId, referer, offset, size, attempts = MAX_ATTEMPTS }) {
    const apiUrl = new URL(`${REVIEWS_HOST}/atlas/v1/reviews/v1/item/${productId}/reviews`);
    apiUrl.searchParams.set('page.size', String(size));
    apiUrl.searchParams.set('page.offset', String(offset));
    apiUrl.searchParams.set('projections', 'reviews.full');

    let lastError;

    for (let attempt = 1; attempt <= attempts; attempt++) {
        const profile = BROWSER_PROFILES[(attempt - 1) % BROWSER_PROFILES.length];
        let retryAfterMs = null;

        try {
            const response = await pool.get(profile).fetch(apiUrl.href, {
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
                    lastError = new Error(`Received a non-JSON response (HTTP ${status})`);
                }
            } else {
                const message = extractErrorMessage(body, status);
                if (!isRetryableStatus(status)) {
                    const error = new Error(message);
                    error.retryable = false;
                    throw error;
                }
                lastError = new Error(message);
                retryAfterMs = getRetryAfterMs(response);
            }
        } catch (error) {
            if (error.retryable === false) throw error;
            lastError = error;
        }

        if (attempt < attempts) {
            const waitMs = computeBackoffMs(attempt, retryAfterMs);
            const nextProfile = BROWSER_PROFILES[attempt % BROWSER_PROFILES.length];
            log.warning(
                `Kroger reviews request failed for ${productId} page ${offset} size ${size} ` +
                    `(${describeError(lastError)}); retrying ${attempt}/${attempts - 1} with profile=${nextProfile} in ${waitMs} ms`,
            );
            await sleep(waitMs);
        }
    }

    throw lastError;
}

async function fetchFirstPage({ pool, productId, referer, attempts }) {
    const sizes = [PAGE_SIZE, ...PAGE_SIZE_FALLBACKS];
    let lastError;

    for (let index = 0; index < sizes.length; index++) {
        const size = sizes[index];
        const sizeAttempts = index === 0 ? attempts : Math.max(3, attempts - 2);
        try {
            const payload = await requestPage({ pool, productId, referer, offset: 0, size, attempts: sizeAttempts });
            return { payload, size };
        } catch (error) {
            if (error.retryable === false) throw error;
            lastError = error;
            if (index < sizes.length - 1) {
                log.warning(
                    `First page for ${productId} failed with page.size=${size} (${describeError(error)}); ` +
                        `trying page.size=${sizes[index + 1]}`,
                );
            }
        }
    }

    throw lastError;
}

async function processProduct({ pool, productUrl, productId, resultsWanted, maxPages, keyword, attempts, onPage }) {
    const seen = new Set();
    let saved = 0;
    let fetchedAnyPage = false;
    let firstPageFailed = false;
    let size = PAGE_SIZE;

    for (let offset = 0; offset < maxPages && saved < resultsWanted; offset++) {
        let payload;
        try {
            if (offset === 0) {
                const first = await fetchFirstPage({ pool, productId, referer: productUrl, attempts });
                size = first.size;
                payload = first.payload;
            } else {
                payload = await requestPage({ pool, productId, referer: productUrl, offset, size, attempts });
            }
            fetchedAnyPage = true;
        } catch (error) {
            const reason = describeError(error);
            if (offset === 0) {
                firstPageFailed = true;
                log.warning(`Could not fetch the first review page for ${productId} (${reason}); deferring this product`);
            } else {
                log.warning(
                    `Stopping pagination for ${productId} at page ${offset} after repeated errors (${reason}); ` +
                        `keeping ${saved} review(s) already collected`,
                );
            }
            break;
        }

        const pageReviews = extractReviews(payload);
        if (!Array.isArray(pageReviews)) {
            log.warning(`Unexpected review response shape for ${productId} page ${offset}; stopping this product`);
            break;
        }

        const batch = [];
        for (const review of pageReviews) {
            const reviewText = String(review?.reviewText ?? '');
            if (keyword && !reviewText.toLowerCase().includes(keyword)) continue;

            const record = cleanReview(review, productUrl, productId);
            if (!record) continue;

            const key = review?.id ?? review?.reviewId ?? review?.submissionId ?? JSON.stringify(record);
            if (seen.has(key)) continue;
            seen.add(key);
            batch.push(record);

            if (saved + batch.length >= resultsWanted) break;
        }

        if (batch.length) {
            await onPage(batch);
            saved += batch.length;
        }

        const { hasMore, totalPages } = extractMeta(payload);
        const reachedLastPage =
            pageReviews.length < size ||
            hasMore === false ||
            (Number.isFinite(totalPages) && offset + 1 >= totalPages);

        if (!pageReviews.length || reachedLastPage) break;
    }

    return { saved, fetchedAnyPage, firstPageFailed };
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

    const pool = createClientPool(proxyUrl);
    const keyword = String(keywordReview || '').trim();

    log.info(
        `Starting Kroger review extraction | urls=${productUrls.length} | target=${resultsWanted} | max_pages=${maxPages}`,
    );

    let totalSaved = 0;
    let fetchedProducts = 0;
    const deferredProducts = [];

    const runProduct = async (productUrl, attempts) => {
        const product = getProductId(productUrl);
        if (!product) {
            log.warning(`Skipping unsupported Kroger product URL: ${productUrl}`);
            return;
        }

        const outcome = await processProduct({
            pool,
            productUrl: product.canonicalUrl,
            productId: product.productId,
            resultsWanted: resultsWanted - totalSaved,
            maxPages,
            keyword,
            attempts,
            onPage: async (batch) => {
                await Dataset.pushData(batch);
                totalSaved += batch.length;
                log.info(`Saved ${batch.length} reviews for ${product.productId}; total=${totalSaved}/${resultsWanted}`);
            },
        });

        if (outcome.fetchedAnyPage) fetchedProducts++;
        else if (outcome.firstPageFailed) deferredProducts.push(productUrl);

        if (outcome.saved === 0 && outcome.fetchedAnyPage) {
            log.warning(`No matching reviews found for ${product.productId}`);
        }
    };

    for (const productUrl of productUrls) {
        if (totalSaved >= resultsWanted) break;
        await runProduct(productUrl, MAX_ATTEMPTS);
    }

    if (totalSaved < resultsWanted && deferredProducts.length) {
        await sleep(PRODUCT_RECOVERY_DELAY_MS);
        log.info(`Recovery pass: retrying ${deferredProducts.length} product(s) whose first page failed`);
        for (const productUrl of deferredProducts) {
            if (totalSaved >= resultsWanted) break;
            await runProduct(productUrl, RECOVERY_MAX_ATTEMPTS);
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
