// scripts/schema.cypher

// Constraints for unique entities
CREATE CONSTRAINT solar_event_id IF NOT EXISTS FOR (s:SolarEvent) REQUIRE s.id IS UNIQUE;
CREATE CONSTRAINT asset_id IF NOT EXISTS FOR (a:Asset) REQUIRE a.id IS UNIQUE;

// Initial Physics Schema
// Sun -> Storm -> Magnetosphere -> Asset Impact

MERGE (sun:Origin {name: 'Sun', type: 'Star'})
MERGE (earth:Planet {name: 'Earth'})

// Define causal relationship path
MERGE (flare:SolarEvent {type: 'SolarFlare', intensity: 'X-Class'})
MERGE (cme:SolarEvent {type: 'CME', speed: '1200km/s'})
MERGE (storm:GeomagneticStorm {tier: 'G4', name: 'Severe Storm'})

MERGE (sun)-[:EJECTS]->(flare)
MERGE (flare)-[:PRECEDES]->(cme)
MERGE (cme)-[:CAUSES]->(storm)
MERGE (storm)-[:IMPACTS]->(earth)

// Define Asset relationships
MERGE (leo:Orbit {name: 'LEO', altitude: '400km'})
MERGE (geo:Orbit {name: 'GEO', altitude: '35786km'})

MERGE (sat1:Asset {id: 'SAT_LEO_001', name: 'Aurora-Watcher-1'})-[:LOCATED_IN]->(leo)
MERGE (sat2:Asset {id: 'SAT_GEO_001', name: 'Gauss-Relay-Prime'})-[:LOCATED_IN]->(geo)

// Effect mapping
MERGE (storm)-[:INFLUENCES {effect: 'AtmosphericDrag'}]->(leo)
MERGE (storm)-[:INFLUENCES {effect: 'DeepDielectricCharging'}]->(geo)
