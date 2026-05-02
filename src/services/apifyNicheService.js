import axios from 'axios';
import { createHash } from 'crypto';

const APIFY_BASE_URL = 'https://api.apify.com/v2';

// Actor IDs use ~ format (username~actor-name)
const ACTORS = {
    realtor: 'olympus~realtor-leads-real-estate-agent-scraper',
    carDealer: 'samstorm~auto-dealer-lead-scraper'
};

const EMAIL_REGEX = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const isGmail = (email = '') => /@gmail\.com$/i.test(String(email || '').trim());
const isWebUrl = (value = '') => /^https?:\/\//i.test(String(value || '').trim());

const collectStrings = (value, list = []) => {
    if (!value) return list;
    if (Array.isArray(value)) {
        value.forEach(item => collectStrings(item, list));
        return list;
    }
    if (typeof value === 'object') {
        Object.values(value).forEach(item => collectStrings(item, list));
        return list;
    }
    list.push(String(value));
    return list;
};

const extractBestEmail = (lead = {}) => {
    const candidates = new Set();
    const addEmail = (value) => {
        if (!value) return;
        const text = String(value);
        const matches = text.match(EMAIL_REGEX);
        if (matches) matches.forEach(match => candidates.add(match.toLowerCase()));
    };

    [
        lead.email,
        lead.sellerEmail,
        lead.ownerEmail,
        lead.contactEmail,
        lead.emails,
        lead.contacts,
        lead.raw_data,
    ].forEach(addEmail);

    const emails = Array.from(candidates);
    if (!emails.length) return '';
    const gmail = emails.find(isGmail);
    return gmail || emails[0];
};

const extractBestWebsite = (lead = {}) => {
    const direct = [
        lead.website,
        lead.url,
        lead.webUrl,
        lead.contact_url,
        lead.contactUrl,
        lead.site,
    ].find(isWebUrl);
    if (direct) return String(direct);

    const pool = collectStrings([
        lead.website,
        lead.url,
        lead.contact_url,
        lead.raw_data,
        lead.contacts,
    ]);
    const firstUrl = pool.find(isWebUrl);
    return firstUrl || '';
};

/**
 * Apify Niche Service
 * Scrapes B2B leads for specific niches using Apify actors
 */
class ApifyNicheService {
    constructor() {
        this.token = process.env.APIFY_API_TOKEN;
        if (!this.token) {
            console.error('⚠️  APIFY_API_TOKEN environment variable is not set!');
        }
    }

    /**
     * Run an Apify actor and wait for results
     * @param {string} actorId - The Apify actor ID
     * @param {Object} input - The actor input parameters
     * @param {number} timeoutSecs - Maximum wait time in seconds
     */
    /**
     * Run actor synchronously and get dataset items (waits for completion)
     * Uses run-sync-get-dataset-items endpoint for immediate results
     */
    async runActorSync(actorId, input, timeoutSecs = 180) {
        try {
            // Use sync endpoint that waits for completion and returns dataset items
            const url = `${APIFY_BASE_URL}/acts/${actorId}/run-sync-get-dataset-items?token=${this.token}`;
            
            console.log(`🚀 Running actor ${actorId} (sync mode)`);
            console.log(`📤 Input:`, JSON.stringify(input).substring(0, 200));
            
            const response = await axios.post(url, input, {
                headers: { 'Content-Type': 'application/json' },
                timeout: timeoutSecs * 1000 // Convert to milliseconds
            });
            
            console.log(`✅ Actor completed. Results count: ${response.data?.length || 0}`);
            
            if (response.data && response.data.length > 0) {
                console.log(`📄 Sample result:`, JSON.stringify(response.data[0]).substring(0, 300));
            }
            
            return response.data || [];
        } catch (error) {
            console.error('❌ Apify Actor Error:', {
                message: error.message,
                status: error.response?.status,
                data: error.response?.data
            });
            throw error;
        }
    }

    /**
     * Legacy async run method (kept for fallback)
     */
    async runActor(actorId, input, timeoutSecs = 120) {
        try {
            // Start the actor run
            const startUrl = `${APIFY_BASE_URL}/acts/${actorId}/runs?token=${this.token}`;
            const startResponse = await axios.post(startUrl, input, {
                headers: { 'Content-Type': 'application/json' }
            });

            const runId = startResponse.data.data.id;
            console.log(`🚀 Started Apify actor ${actorId}, run ID: ${runId}`);

            // Poll for completion
            let isFinished = false;
            let attempts = 0;
            const maxAttempts = timeoutSecs / 5;

            while (!isFinished && attempts < maxAttempts) {
                await new Promise(resolve => setTimeout(resolve, 5000));
                
                const statusUrl = `${APIFY_BASE_URL}/acts/${actorId}/runs/${runId}?token=${this.token}`;
                const statusResponse = await axios.get(statusUrl);
                const status = statusResponse.data.data.status;

                if (status === 'SUCCEEDED') {
                    isFinished = true;
                } else if (['FAILED', 'ABORTED', 'TIMED-OUT'].includes(status)) {
                    throw new Error(`Actor run ${status}: ${statusResponse.data.data.errorMessage || 'Unknown error'}`);
                }
                
                attempts++;
            }

            if (!isFinished) {
                throw new Error('Actor run timed out');
            }

            // Get the results from dataset
            const datasetId = startResponse.data.data.defaultDatasetId;
            const resultsUrl = `${APIFY_BASE_URL}/datasets/${datasetId}/items?token=${this.token}`;
            const resultsResponse = await axios.get(resultsUrl);

            return resultsResponse.data;
        } catch (error) {
            console.error('❌ Apify Actor Error:', error.response?.data || error.message);
            throw error;
        }
    }

    /**
     * Scrape Google Maps for businesses by niche
     * @param {string} niche - e.g., 'real_estate', 'car_sales', 'hr', 'second_hand'
     * @param {string} geoScope - Country / region text (required for production searches), e.g. Spain
     * @param {string} query - Optional custom search query (overrides default terms)
     */
    async scoutByNiche(niche, geoScope = '', query = '', options = {}) {
        console.log(`🔍 Starting niche scout for: ${niche}, geo: ${geoScope || 'none'}, query: ${query || 'default'}`);
        const maxResults = Math.max(1, Math.min(Number(options.maxResults || 20), 100));

        try {
            let results = [];

            // If custom query provided, use it directly
            if (query) {
                results = await this.scrapeGoogleMaps([query], niche, geoScope, maxResults);
                return {
                    people: results,
                    total_entries: results.length,
                    niche,
                    location: geoScope,
                };
            }

            // Use niche-specific actors that have been tested and work
            switch (niche) {
                case 'real_estate':
                    // Use Google Maps scraper with real estate search terms
                    results = await this.scrapeGoogleMaps(['real estate agencies', 'real estate agents', 'property brokers', 'realtors'], niche, geoScope, maxResults);
                    break;
                case 'car_sales':
                    // Use Google Maps scraper with car dealership search terms
                    results = await this.scrapeGoogleMaps(['car dealerships', 'auto sales', 'car showrooms', 'automotive dealers'], niche, geoScope, maxResults);
                    break;
                case 'hr':
                    // Use Google Maps scraper with HR/recruitment search terms
                    results = await this.scrapeGoogleMaps(['recruitment agencies', 'staffing companies', 'HR consulting', 'employment agencies'], niche, geoScope, maxResults);
                    break;
                case 'second_hand':
                    // Use Google Maps scraper with second hand retail search terms
                    results = await this.scrapeGoogleMaps(['second hand shops', 'vintage stores', 'thrift shops', 'consignment shops', 'resale boutiques'], niche, geoScope, maxResults);
                    break;
                default:
                    throw new Error(`Unknown niche: ${niche}`);
            }

            return {
                people: results,
                total_entries: results.length,
                niche,
                location: geoScope,
            };
        } catch (error) {
            console.error('❌ Apify Niche Scout Error:', error.message);
            return {
                people: [],
                total_entries: 0,
                niche,
                location: geoScope,
                error: error.message
            };
        }
    }

    /**
     * Scrape Car Dealerships using the working actor
     * Actor: samstorm/auto-dealer-lead-scraper
     */
    async scrapeCarSales(location = '') {
        try {
            // Use the ~ format for Actor ID
            const actorId = ACTORS.carDealer; // 'samstorm~auto-dealer-lead-scraper'
            
            const input = {
                searchQuery: location ? `car dealerships in ${location}` : 'car dealerships',
                location: location || 'Houston, TX',
                maxResults: 20,
                enrichEmails: true,
                enrichSocials: true,
                verifyEmails: true,
                businessType: 'Car Dealership',
                outputFormat: 'full'
            };

            console.log(`🚀 Starting actor ${actorId} with input:`, JSON.stringify(input));
            const results = await this.runActorSync(actorId, input, 180);
            console.log(`✅ Actor returned ${results.length} results`);
            
            if (!results || results.length === 0) {
                console.log('⚠️ Actor returned empty results, trying fallback...');
                return this.scrapeGoogleMaps(['car dealerships', 'auto sales', 'car showrooms'], 'car_sales', location);
            }

            // Transform results to match our lead format
            return results.map(dealer => ({
                id: `car_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                first_name: this.extractFirstName(dealer.name),
                last_name: '',
                full_name: dealer.name,
                email: extractBestEmail(dealer),
                phone: dealer.phone || '',
                title: 'Sales Manager',
                organization: dealer.name,
                location: dealer.address || '',
                website: extractBestWebsite(dealer),
                linkedin_url: '',
                enrichment_status: (extractBestEmail(dealer) || dealer.phone || extractBestWebsite(dealer)) ? 'found' : 'pending',
                source: 'Apify - Car Dealerships',
                raw_data: dealer
            }));
        } catch (error) {
            console.error('❌ Car Sales scraper failed:', {
                message: error.message,
                response: error.response?.data,
                status: error.response?.status
            });
            // Fallback to Google Maps
            console.log('Falling back to Google Maps scraper...');
            return this.scrapeGoogleMaps(['car dealerships', 'auto sales', 'car showrooms'], 'car_sales', location);
        }
    }

    /**
     * Scrape Realtor Leads using the tested working actor
     * Actor: scraped/realtor-agents-by-zip-code-preprocessed-data
     */
    async scrapeRealtorLeads(location = '') {
        try {
            // The working actor: olympus~realtor-leads-real-estate-agent-scraper
            // Uses ~ format for Actor ID
            const actorId = ACTORS.realtor; // 'olympus~realtor-leads-real-estate-agent-scraper'
            
            // This actor takes city/state location
            const input = {
                location: location || 'Houston, TX',
                maxResults: 20
            };

            console.log(`🚀 Starting actor ${actorId} with location:`, input.location);
            const results = await this.runActorSync(actorId, input, 180);
            console.log(`✅ Actor returned ${results.length} results`);
            
            if (!results || results.length === 0) {
                console.log('⚠️ Actor returned empty results, trying fallback...');
                return this.scrapeGoogleMaps(['real estate agents', 'realtors', 'real estate brokers'], 'real_estate', location);
            }

            // Transform results to match our lead format
            // The actor returns realtor data with various fields
            return results.map(agent => ({
                id: `realtor_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                first_name: this.extractFirstName(agent['Full Name'] || agent.name || agent.fullName),
                last_name: '',
                full_name: agent['Full Name'] || agent.name || agent.fullName || '',
                email: extractBestEmail(agent),
                phone: agent['Mobile Phones'] || agent['Office Phone'] || agent.phone || '',
                title: agent['Title'] || agent.title || 'Real Estate Agent',
                organization: agent['Office Name'] || agent.officeName || agent.company || '',
                location: agent['Areas serviced'] || agent['Office Address'] || agent.location || agent.address || '',
                website: extractBestWebsite(agent),
                linkedin_url: '',
                enrichment_status: (extractBestEmail(agent) || agent['Mobile Phones'] || agent['Office Phone'] || agent.phone || extractBestWebsite(agent)) ? 'found' : 'pending',
                source: 'Apify - Realtor Leads',
                raw_data: agent
            }));
        } catch (error) {
            console.error('❌ Realtor Leads scraper failed:', {
                message: error.message,
                response: error.response?.data,
                status: error.response?.status
            });
            // Fallback to Google Maps if Realtor actor fails
            console.log('Falling back to Google Maps scraper...');
            return this.scrapeGoogleMaps(['real estate agents', 'realtors', 'real estate brokers'], 'real_estate', location);
        }
    }

    /**
     * Fallback Google Maps scraper for other niches
     */
    /**
     * @param geoScope Required for normal flows — ISO country name (e.g. Spain) so Maps runs country-wide,
     *        not anchored to one city when the caller provides a whole country label.
     */
    async scrapeGoogleMaps(queries, niche, geoScope = '', maxResults = 20) {
        const searchQueries =
            geoScope && String(geoScope).trim()
                ? queries.map((q) => `${q} in ${String(geoScope).trim()}`)
                : queries;
        const cappedResults = Math.max(1, Math.min(Number(maxResults || 20), 100));

        console.log(`🔍 Google Maps search: ${searchQueries.join(', ')}`);

        try {
            // Use compass/crawler-google-places (official Google Maps scraper)
            // Actor ID format uses ~ for store actors: compass~crawler-google-places
            const actorId = 'compass~crawler-google-places';
            
            const input = {
                searchStringsArray: searchQueries,
                maxCrawledPlaces: cappedResults,
                maxImages: 0,
                scrapeContacts: true,
                scrapeContactsDelay: 1000,
                maxReviews: 0,
                language: 'en',
                includeWebResults: false
            };
            
            console.log(`🚀 Starting Google Places scraper with ${searchQueries.length} queries`);
            const results = await this.runActorSync(actorId, input, 180);
            console.log(`✅ Google Places returned ${results.length} results`);

            return results.map((place) => {
                const businessName = place.name || place.title || place.companyName || place.organization || '';
                const locationText =
                    place.address ||
                    place.location?.formattedAddress ||
                    [place.city, place.state, place.countryCode].filter(Boolean).join(', ');
                const bestEmail = extractBestEmail(place);
                const bestWebsite = extractBestWebsite(place);

                const stableFingerprint = [businessName, locationText, bestWebsite].filter(Boolean).join('|').toLowerCase().trim();
                const deterministicId =
                    place.placeId ||
                    (typeof place.url === 'string' && /^https?:\/\//i.test(place.url.trim()) ? place.url.trim() : null) ||
                    (stableFingerprint
                        ? `gmaps_${createHash('sha256').update(stableFingerprint).digest('hex').slice(0, 40)}`
                        : `gmaps_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`);

                return {
                id: deterministicId,
                first_name: this.extractFirstName(businessName),
                last_name: '',
                full_name: businessName,
                email: bestEmail,
                phone: place.phone || place.phoneUnformatted || '',
                title: this.inferTitleFromNiche(niche),
                organization: businessName,
                location: locationText,
                website: bestWebsite,
                linkedin_url: '',
                enrichment_status: (bestEmail || place.phone || place.phoneUnformatted || bestWebsite) ? 'found' : 'pending',
                source: `Apify - ${niche}`,
                raw_data: place
                };
            });
        } catch (error) {
            console.error('❌ Google Maps scraper failed:', {
                message: error.message,
                status: error.response?.status,
                data: error.response?.data
            });
            return [];
        }
    }

    /**
     * Extract first name from business name (best effort)
     */
    extractFirstName(businessName) {
        if (!businessName) return '';
        // Remove common suffixes
        const cleaned = businessName
            .replace(/(LLC|Inc|Ltd|Corp|Company|Co\.?|Realty|Group|Team|Associates)/gi, '')
            .trim();
        // Try to get first word that looks like a name
        const words = cleaned.split(/\s+/);
        if (words.length > 0 && words[0].length > 2) {
            return words[0].replace(/[^a-zA-Z]/g, '');
        }
        return businessName.substring(0, 30);
    }

    /**
     * Infer a professional title based on niche
     */
    inferTitleFromNiche(niche) {
        const titles = {
            real_estate: 'Real Estate Agent',
            car_sales: 'Sales Manager',
            hr: 'HR Consultant',
            second_hand: 'Store Owner'
        };
        return titles[niche] || 'Business Owner';
    }

    /**
     * Alternative: Scrape LinkedIn for professionals (requires LinkedIn scraper actor)
     * Note: This would need a different actor and session cookies
     */
    async scrapeLinkedInForNiche(niche, location = '') {
        // This is a placeholder for LinkedIn scraping
        // Would require linkedin-profile-scraper or similar actor
        console.log('LinkedIn scraping not yet implemented');
        return { people: [], total_entries: 0 };
    }
}

export default new ApifyNicheService();
