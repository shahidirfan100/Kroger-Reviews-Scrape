import { Actor, log } from 'apify';
import { Dataset } from 'crawlee';
import { chromium } from 'patchright';

const PAGE_SIZE = 64;
const MAX_RETRIES = 3;

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
    const productId = pathParts.at(-1)?.match(/^(\d{8,14})(?:\D|$)/)?.[1]
        || pathParts.find((part) => /^\d{8,14}$/.test(part));

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

function getBrowserProxy(proxyUrl) {
    if (!proxyUrl) return undefined;

    const parsed = new URL(proxyUrl);
    return {
        server: `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}`,
        ...(parsed.username && { username: decodeURIComponent(parsed.username) }),
        ...(parsed.password && { password: decodeURIComponent(parsed.password) }),
    };
}

async function createApiClient(proxyUrl) {
    const context = await chromium.launchPersistentContext('./patchright-profile', {
        channel: 'chrome',
        headless: false,
        noViewport: true,
        args: ['--disable-quic'],
        ...(proxyUrl && { proxy: getBrowserProxy(proxyUrl) }),
    });
    const page = await context.newPage();
    let originReady = false;

    return {
        async fetchJson(url) {
            if (!originReady) {
                try {
                    await page.goto('https://www.kroger.com', { waitUntil: 'commit', timeout: 30_000 });
                } catch (error) {
                    const reason = String(error.message || error).split(/\r?\n/, 1)[0];
                    log.warning(`Kroger origin warm-up failed (${reason}); continuing with the API fetch`);
                }
                originReady = true;
            }

            for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
                try {
                    const result = await page.evaluate(async (apiUrl) => {
                        const response = await fetch(apiUrl, { credentials: 'include' });
                        return { status: response.status, body: await response.text() };
                    }, url);
                    if (result.status < 200 || result.status >= 300) {
                        throw new Error(`Kroger API returned HTTP ${result.status}`);
                    }
                    return JSON.parse(result.body);
                } catch (error) {
                    if (attempt === MAX_RETRIES) throw error;
                    const reason = String(error.message || error).split(/\r?\n/, 1)[0];
                    const waitMs = attempt * 1500;
                    log.warning(`Retry ${attempt}/${MAX_RETRIES - 1} after API request error (${reason}); waiting ${waitMs} ms`);
                    await new Promise((resolve) => setTimeout(resolve, waitMs));
                }
            }

            throw new Error(`API request failed after ${MAX_RETRIES} attempts: ${url}`);
        },
        async close() {
            await context.close();
        },
    };
}

async function fetchReviews({ apiClient, productUrl, productId, resultsWanted, maxPages, keywordReview }) {
    const reviews = [];
    const seen = new Set();

    for (let page = 0; page < maxPages && reviews.length < resultsWanted; page++) {
        const offset = page;
        const apiUrl = new URL(`https://www.kroger.com/atlas/v1/reviews/v1/item/${productId}/reviews`);
        apiUrl.searchParams.set('page.size', String(PAGE_SIZE));
        apiUrl.searchParams.set('page.offset', String(offset));
        apiUrl.searchParams.set('projections', 'reviews.full');

        const payload = await apiClient.fetchJson(apiUrl.href);
        const pageReviews = payload?.data?.reviews?.product?.reviews;
        if (!Array.isArray(pageReviews)) {
            throw new Error(`Review array missing for ${productId}; response shape may have changed`);
        }

        for (const review of pageReviews) {
            const reviewText = String(review.reviewText ?? '');
            if (keywordReview && !reviewText.toLowerCase().includes(keywordReview.toLowerCase())) continue;

            const record = cleanReview(review, productUrl, productId);
            if (!record) continue;

            const key = review.id ?? review.reviewId ?? review.submissionId ?? JSON.stringify(record);
            if (seen.has(key)) continue;
            seen.add(key);
            reviews.push(record);

            if (reviews.length >= resultsWanted) break;
        }

        const hasMore = payload?.meta?.reviews?.page?.hasMore;
        if (!pageReviews.length || hasMore === false || pageReviews.length < PAGE_SIZE) break;
    }

    return reviews;
}

await Actor.init();

let exitCode = 0;
let apiClient;

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
    const maxPages = Number.isFinite(Number(maxPagesRaw))
        ? Math.max(1, Math.floor(Number(maxPagesRaw)))
        : 10;

    if (!Array.isArray(startUrls) || startUrls.length === 0) {
        throw new Error('Provide at least one Kroger product URL in startUrls.');
    }

    const productUrls = startUrls.map(getUrlValue).filter(Boolean);
    const proxyEnabled = Boolean(proxyConfiguration?.useApifyProxy);
    const customProxyUrls = Array.isArray(proxyConfiguration?.proxyUrls) && proxyConfiguration.proxyUrls.length > 0;
    const proxyConfig = (proxyEnabled || customProxyUrls) && Actor.isAtHome()
        ? await Actor.createProxyConfiguration({ ...proxyConfiguration })
        : null;
    const proxyUrl = proxyConfig ? await proxyConfig.newUrl() : undefined;

    if ((proxyEnabled || customProxyUrls) && !Actor.isAtHome()) {
        log.info('Skipping Apify Proxy for local execution.');
    }

    log.info('Starting Patchright Chrome API extraction');
    apiClient = await createApiClient(proxyUrl);
    log.info(`Starting Kroger review extraction | urls=${productUrls.length} | target=${resultsWanted} | max_pages=${maxPages}`);

    let totalSaved = 0;
    for (const productUrl of productUrls) {
        if (totalSaved >= resultsWanted) break;

        const product = getProductId(productUrl);
        if (!product) {
            log.warning(`Skipping unsupported Kroger product URL: ${productUrl}`);
            continue;
        }

        const batch = await fetchReviews({
            apiClient,
            productUrl: product.canonicalUrl,
            productId: product.productId,
            resultsWanted: resultsWanted - totalSaved,
            maxPages,
            keywordReview: String(keywordReview || '').trim(),
        });

        if (batch.length) {
            await Dataset.pushData(batch);
            totalSaved += batch.length;
            log.info(`Saved ${batch.length} reviews for ${product.productId}; total=${totalSaved}/${resultsWanted}`);
        } else {
            log.warning(`No matching reviews found for ${product.productId}`);
        }
    }

    if (totalSaved === 0) throw new Error('No reviews were returned for the supplied product URLs.');
    log.info(`Finished | saved=${totalSaved} | requested=${resultsWanted}`);
} catch (error) {
    exitCode = 1;
    const reason = String(error.message || error).split(/\r?\n/, 1)[0];
    log.error(`Actor failed: ${reason}`);
} finally {
    try {
        if (apiClient) await apiClient.close();
    } finally {
        await Actor.exit({ exitCode });
    }
}
