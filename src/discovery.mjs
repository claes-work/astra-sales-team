import { buildDiscoveryRequest } from './icp.mjs';
import { searchPlaces } from './places.mjs';

// Google ist nur Kandidatenquelle. Discovery-Metadaten werden nie als Fakten gewertet.
export async function discoverWithPlaces({ profile, key, city, country, queryIndex, websites = false, fetchImpl }) {
  const request = buildDiscoveryRequest(profile, { city, country, queryIndex });
  const places = await searchPlaces({ key, request, websites, fetchImpl });
  return [...new Map(places.map(place => [place.id, {
    id: place.id,
    discovery: { provider: 'google_places', place },
  }])).values()];
}
