import axios from 'axios';

const APIFY_BASE_URL = 'https://api.apify.com/v2';

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
    async runActor(actorId, input, timeoutSecs = 120) {
        try {
            // Start the actor run
            const startUrl = `${APIFY_BASE_URL}/acts/${actorId}/runs?token=${this.token}`;
            const startResponse = await axios.post(startUrl, {
                ...input,
                timeout: timeoutSecs
            }, {
                headers: { 'Content-Type': 'application/json' }
            });

            const runId = startResponse.data.data.id;
            console.log(`🚀 Started Apify actor ${actorId}, run ID: ${runId}`);

            // Poll for completion
            let isFinished = false;
            let attempts = 0;
            const maxAttempts = timeoutSecs / 5; // Check every 5 seconds

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
     * @param {string} location - Optional location filter
     */
    async scoutByNiche(niche, location = '') {
        console.log(`🔍 Starting niche scout for: ${niche}, location: ${location || 'any'}`);

        try {
            let results = [];

            // Use niche-specific actors that have been tested and work
            switch (niche) {
                case 'real_estate':
                    // Use the working Realtor Leads Scraper
                    results = await this.scrapeRealtorLeads(location);
                    break;
                case 'car_sales':
                    results = await this.scrapeGoogleMaps(['car dealerships', 'auto sales', 'car showrooms'], niche, location);
                    break;
                case 'hr':
                    results = await this.scrapeGoogleMaps(['recruitment agencies', 'staffing companies', 'HR consulting'], niche, location);
                    break;
                case 'second_hand':
                    results = await this.scrapeGoogleMaps(['second hand shops', 'vintage stores', 'thrift shops'], niche, location);
                    break;
                default:
                    throw new Error(`Unknown niche: ${niche}`);
            }

            return {
                people: results,
                total_entries: results.length,
                niche,
                location
            };
        } catch (error) {
            console.error('❌ Apify Niche Scout Error:', error.message);
            return {
                people: [],
                total_entries: 0,
                niche,
                location,
                error: error.message
            };
        }
    }

    /**
     * Scrape Realtor Leads using the tested working actor
     * Actor: apify/realtor-leads-scraper (or similar - the one you tested)
     */
    async scrapeRealtorLeads(location = '') {
        try {
            // The actor ID for "Realtor Leads Real Estate Agent Scraper"
            // Using the community actor that was tested successfully
            const actorId = 'apify/realtor-leads-scraper';
            
            const input = {
                location: location || 'United States',
                maxResults: 50,
                includeContactInfo: true
            };

            const results = await this.runActor(actorId, input, 180);

            // Transform results to match our lead format
            return results.map(person => ({
                id: person.id || `realtor_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                first_name: person.firstName || person.first_name || this.extractFirstName(person.fullName || person.name),
                last_name: person.lastName || person.last_name || '',
                full_name: person.fullName || person.name || `${person.firstName} ${person.lastName}`,
                email: person.email || person.emails?.[0] || '',
                phone: person.phone || person.phones?.[0] || '',
                title: person.title || 'Real Estate Agent',
                organization: person.company || person.brokerage || person.organization || '',
                location: person.location || person.address || person.city || '',
                website: person.website || person.websiteUrl || '',
                linkedin_url: person.linkedin || person.linkedinUrl || '',
                enrichment_status: (person.email || person.phone) ? 'found' : 'pending',
                source: 'Apify - Realtor Leads',
                raw_data: person
            }));
        } catch (error) {
            console.error('❌ Realtor Leads scraper failed:', error.message);
            // Fallback to Google Maps if Realtor actor fails
            console.log('Falling back to Google Maps scraper...');
            return this.scrapeGoogleMaps(['real estate agents', 'realtors', 'real estate brokers'], 'real_estate', location);
        }
    }

    /**
     * Fallback Google Maps scraper for other niches
     */
    async scrapeGoogleMaps(queries, niche, location = '') {
        const searchQueries = location 
            ? queries.map(q => `${q} in ${location}`)
            : queries;

        console.log(`🔍 Google Maps search: ${searchQueries.join(', ')}`);

        try {
            const results = await this.runActor('apify/google-maps-scraper', {
                searchStringsArray: searchQueries,
                maxCrawledPlaces: 20,
                maxImages: 0,
                scrapeContacts: true,
                scrapeContactsDelay: 1000,
                maxReviews: 0,
                language: 'en',
                includeWebResults: false
            }, 180);

            return results.map(place => ({
                id: place.placeId || `gmaps_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                first_name: this.extractFirstName(place.name),
                last_name: '',
                full_name: place.name,
                email: place.email || '',
                phone: place.phone || place.phoneUnformatted || '',
                title: this.inferTitleFromNiche(niche),
                organization: place.name,
                location: place.address || place.location?.formattedAddress || '',
                website: place.website || '',
                linkedin_url: '',
                enrichment_status: (place.email || place.phone) ? 'found' : 'pending',
                source: `Apify - ${niche}`,
                raw_data: place
            }));
        } catch (error) {
            console.error('❌ Google Maps scraper failed:', error.message);
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
