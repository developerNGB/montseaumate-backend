import axios from 'axios';
import pool from '../db/pool.js';

const APOLLO_BASE_URL = 'https://api.apollo.io/api/v1';

/**
 * Apollo Service
 * Handles lead discovery and enrichment via Apollo.io API
 */
class ApolloService {
    constructor() {
        this.apiKey = process.env.APOLLO_API_KEY;
        if (!this.apiKey) {
            console.error('⚠️  APOLLO_API_KEY environment variable is not set!');
        }
    }

    /**
     * Search for net new people based on niche/criteria
     * @param {Object} criteria - Search filters (titles, locations, etc.)
     */
    async searchPeople(criteria = {}) {
        try {
            const response = await axios.post(`${APOLLO_BASE_URL}/mixed_people/api_search`, {
                person_titles: criteria.titles || [],
                person_locations: criteria.locations || [],
                q_keywords: criteria.keywords || '',
                page: criteria.page || 1,
                per_page: criteria.perPage || 10
            }, {
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'X-Api-Key': this.apiKey
                }
            });

            return response.data;
        } catch (error) {
            console.error('❌ Apollo Search Error:', error.response?.data || error.message);
            throw error;
        }
    }

    /**
     * Enrich a specific person to get their contact details (Email/Phone)
     * Note: This usually consumes credits in Apollo
     * @param {string} personId - The Apollo ID of the person
     */
    async enrichPerson(personId) {
        try {
            const response = await axios.post(`${APOLLO_BASE_URL}/people/enrich`, {
                id: personId
            }, {
                headers: {
                    'Content-Type': 'application/json',
                    'X-Api-Key': this.apiKey
                }
            });

            return response.data;
        } catch (error) {
            console.error('❌ Apollo Enrichment Error:', error.response?.data || error.message);
            throw error;
        }
    }

    /**
     * Niche-specific scouting
     * @param {string} niche - e.g., 'real_estate', 'car_sales', 'hr'
     */
    async scoutByNiche(niche) {
        let titles = [];
        let keywords = '';

        switch (niche) {
            case 'real_estate':
                titles = ['Real Estate Agent', 'Broker', 'Property Manager', 'Agency Owner'];
                keywords = 'real estate, property, realtor';
                break;
            case 'car_sales':
                titles = ['Sales Manager', 'Dealership Owner', 'Automotive Sales'];
                keywords = 'car sales, dealership, automotive';
                break;
            case 'hr':
                titles = ['HR Director', 'Talent Acquisition', 'Human Resources Manager'];
                keywords = 'recruitment, staffing, hr';
                break;
            case 'second_hand':
                titles = ['Store Owner', 'Retail Manager', 'E-commerce Manager'];
                keywords = 'second hand, vintage, clothes, resale';
                break;
            default:
                keywords = niche;
        }

        return this.searchPeople({ titles, keywords });
    }
}

export default new ApolloService();
