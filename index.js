const { chromium } = require('playwright');
const TelegramBot = require('node-telegram-bot-api');
// cron removed — scheduling handled by GitHub Actions
const fs = require('fs');

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL = process.env.CHANNEL;
const AFFILIATE_TAG = process.env.AFFILIATE_TAG;

if (!BOT_TOKEN || !CHANNEL || !AFFILIATE_TAG) {
    console.error("Missing required env vars: BOT_TOKEN, CHANNEL, AFFILIATE_TAG");
    process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: false });

// ---------- FILE STORAGE ----------

function loadPosted() {
    if (!fs.existsSync("posted.json")) {
        fs.writeFileSync("posted.json", "[]");
    }
    return JSON.parse(fs.readFileSync("posted.json"));
}

function savePosted(data) {
    fs.writeFileSync("posted.json", JSON.stringify(data, null, 2));
}

// ---------- AMAZON HELPERS ----------

function extractASIN(url) {
    const match = url.match(/\/(dp(?:\/d)?|gp\/product)\/([A-Z0-9]{10})/);
    return match ? match[2] : null;
}

function generateAffiliateLink(asin) {
    return `https://www.amazon.in/dp/${asin}?tag=${AFFILIATE_TAG}`;
}

// ---------- SCRAPER ----------

async function scrapeDeals() {
    console.log("Starting scrape...");

    const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox']
    });

    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    });

    const page = await context.newPage();

    try {
        // STEP 1: Open DesiDime New Page
        await page.goto("https://www.desidime.com/new", {
            waitUntil: "domcontentloaded",
            timeout: 60000
        });

        await page.waitForTimeout(5000);

        // Scroll down multiple times to load more deals (lazy loading)
        for (let i = 0; i < 5; i++) {
            await page.evaluate(() => window.scrollBy(0, window.innerHeight));
            await page.waitForTimeout(2000);
        }

        // Scroll back to top
        await page.evaluate(() => window.scrollTo(0, 0));

        // STEP 2: Collect Amazon Deals with Title, Price & Discount
        const deals = await page.$$eval(
            '.l-deal-box',
            boxes =>
                boxes.slice(0, 100).map(box => {
                    const store = box.querySelector('.l-deal-store a')?.innerText?.trim();
                    if (!store || !store.toLowerCase().includes("amazon")) return null;

                    const titleEl = box.querySelector('.l-deal-dsp a');
                    const priceEl = box.querySelector('.l-deal-price');
                    const discountEl = box.querySelector('.l-deal-discount');

                    return titleEl
                        ? {
                            title: titleEl.innerText.replace(/^\d+°\s*/, '').trim(),
                            price: priceEl ? priceEl.innerText.trim() : "",
                            discount: discountEl ? discountEl.innerText.trim() : "",
                            url: "https://www.desidime.com" + titleEl.getAttribute('href')
                        }
                        : null;
                }).filter(Boolean)
        );

        console.log("Amazon deals found:", deals.length);

        let posted = loadPosted();
        let postedCount = 0;

        // STEP 3: Process each deal separately
        for (let deal of deals) {
            if (postedCount >= 10) break;

            const dealPage = await context.newPage();

            try {
                await dealPage.goto(deal.url, {
                    waitUntil: "domcontentloaded",
                    timeout: 60000
                });

                await dealPage.waitForTimeout(3000);

                // Strategy 1: Extract Amazon URL from link innerText (DesiDime shows Amazon URLs as visible text)
                let asin = null;

                const amazonText = await dealPage.$$eval("a", links =>
                    links
                        .map(a => a.innerText.trim())
                        .find(text => text.includes("amazon.in"))
                );

                if (amazonText) {
                    asin = extractASIN(amazonText);
                }

                // Strategy 2: If ASIN not found in text, follow the Buy Now redirect
                if (!asin) {
                    const redirectUrl = await dealPage.$eval(
                        'a.btn-buynow, a[href*="visit.desidime.com"]',
                        a => a.href
                    ).catch(() => null);

                    if (redirectUrl) {
                        try {
                            const redirectPage = await context.newPage();
                            await redirectPage.goto(redirectUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
                            // Wait for redirect to reach Amazon (JS redirect may take time)
                            await redirectPage.waitForURL(/amazon\.(in|co\.in)/, { timeout: 15000 }).catch(() => { });
                            const finalUrl = redirectPage.url();
                            console.log("Redirect resolved to:", finalUrl);
                            asin = extractASIN(finalUrl);
                            await redirectPage.close();
                        } catch (e) {
                            console.log("Redirect follow failed:", e.message);
                        }
                    }
                }

                if (!asin) {
                    console.log("No ASIN found for:", deal.title);
                    await dealPage.close();
                    continue;
                }
                if (posted.includes(asin)) {
                    console.log("Already posted ASIN:", asin);
                    await dealPage.close();
                    continue;
                }

                const affiliateLink = generateAffiliateLink(asin);

                // Extract product image from the Amazon page
                let imageUrl = null;
                try {
                    const amazonPage = await context.newPage();
                    await amazonPage.goto(`https://www.amazon.in/dp/${asin}`, {
                        waitUntil: "domcontentloaded",
                        timeout: 30000
                    });
                    await amazonPage.waitForTimeout(3000);

                    imageUrl = await amazonPage.$eval(
                        '#landingImage, #imgBlkFront, #main-image, .a-dynamic-image',
                        img => img.src || img.getAttribute('data-old-hires') || img.getAttribute('data-a-dynamic-image')
                    ).catch(() => null);

                    // If data-a-dynamic-image returned a JSON string, extract the first URL
                    if (imageUrl && imageUrl.startsWith('{')) {
                        try {
                            const urls = Object.keys(JSON.parse(imageUrl));
                            imageUrl = urls[urls.length - 1] || null; // last key = highest res
                        } catch { imageUrl = null; }
                    }

                    await amazonPage.close();
                    console.log("Amazon image URL:", imageUrl);
                } catch (imgErr) {
                    console.log("Failed to fetch Amazon image:", imgErr.message);
                }

                const message = `🔥 *${deal.title}*

💰 Price: ₹${deal.price}
🏷 Discount: ${deal.discount}

👉 [Buy Now](${affiliateLink})

#AmazonDeal`;

                if (imageUrl) {
                    await bot.sendPhoto(CHANNEL, imageUrl, {
                        caption: message,
                        parse_mode: "Markdown"
                    });
                } else {
                    await bot.sendMessage(CHANNEL, message, { parse_mode: "Markdown" });
                }

                console.log("Posted:", asin);

                posted.push(asin);
                savePosted(posted);

                postedCount++;

                await dealPage.close();
                await page.waitForTimeout(5000);

            } catch (err) {
                console.log("Error processing deal:", err.message);
                await dealPage.close();
            }
        }

    } catch (err) {
        console.log("Main error:", err.message);
    }

    await browser.close();
    console.log("Scrape finished.\n");
}

// Run once and exit (GitHub Actions handles scheduling)
scrapeDeals()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));