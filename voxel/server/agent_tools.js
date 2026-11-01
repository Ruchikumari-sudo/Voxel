// 1. Tool: Check for existing tickets within 25 meters (Deduplication)
export function checkNearbyDuplicates(db, lat, lon, thresholdMeters = 25) {
  // Haversine / spatial distance query over existing open tickets
  const openTickets = db.tickets.filter(t => t.status !== "resolved");
  for (const ticket of openTickets) {
    const dist = calculateDistanceMeters(lat, lon, ticket.lat, ticket.lon);
    if (dist <= thresholdMeters) {
      return ticket; // Existing parent ticket found
    }
  }
  return null;
}

// 2. Tool: Calculate Dynamic Severity Multiplier based on location
export function getGeoMultiplier(lat, lon) {
  // Proximity to sensitive POIs (schools, metro, hospitals)
  // In production: OSM Overpass API query; For MVP: radius checks or ward density
  return 1.25; // 25% urgency boost near high-transit zones
}

function calculateDistanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371e3;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}