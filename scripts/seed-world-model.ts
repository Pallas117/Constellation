import neo4j from 'neo4j-driver';

const uri = process.env.NEO4J_URI || 'bolt://127.0.0.1:7687';
const user = process.env.NEO4J_USER || 'neo4j';
const password = process.env.NEO4J_PASS || 'password';

const driver = neo4j.driver(uri, neo4j.auth.basic(user, password));

async function seed() {
    const session = driver.session();
    try {
        console.log('🌱 Seeding World Model (Neo4j)...');

        // 1. Clear existing data (optional, but good for clean seed)
        // await session.run('MATCH (n) DETACH DELETE n');

        // 2. Create Schema / Nodes (Split into multiple runs)
        const schemaStatements = [
            "CREATE CONSTRAINT IF NOT EXISTS FOR (e:Entity) REQUIRE e.id IS UNIQUE",
            "MERGE (sun:Entity {id: 'SUN', label: 'Solar Body', type: 'Star'})",
            "MERGE (earth:Entity {id: 'EARTH', label: 'Planetary Body', type: 'Planet'})",
            "MERGE (belts:Entity {id: 'VAN_ALLEN_BELTS', label: 'Radiation Belts', type: 'Environment'})",
            "MERGE (magneto:Entity {id: 'MAGNETOSPHERE', label: 'Protective Layer', type: 'Environment'})",
            "MERGE (sun)-[:CAUSES {mechanism: 'Solar Wind'}]->(magneto)",
            "MERGE (magneto)-[:PROTECTS]->(earth)",
            "MERGE (magneto)-[:CONTAINS]->(belts)",
            "MERGE (seu:Anomaly {id: 'SEU', label: 'Single Event Upset', type: 'Error'})",
            "MERGE (charging:Anomaly {id: 'CHARGING', label: 'Surface Charging', type: 'Error'})",
            "MERGE (belts)-[:CAUSES {condition: 'High Flux'}]->(seu)",
            "MERGE (belts)-[:CAUSES {condition: 'Relativistic Electrons'}]->(charging)"
        ];

        for (const stmt of schemaStatements) {
            await session.run(stmt);
        }

        // 3. Add Physics Rules (Grounded Truth)
        const physicsStatements = [
            "MERGE (rule1:Rule {id: 'LORENTZ_FORCE', label: 'Lorentz Force', equation: 'F = q(E + v x B)'})",
            "MERGE (rule2:Rule {id: 'ADIA_INVARIANTS', label: 'Adiabatic Invariants', application: 'Particle Trapping'})",
            "MERGE (belts)-[:GOVERNED_BY]->(rule1)",
            "MERGE (belts)-[:GOVERNED_BY]->(rule2)"
        ];

        for (const stmt of physicsStatements) {
            await session.run(stmt);
        }

        console.log('✅ World Model seeded successfully.');
    } catch (error) {
        console.error('❌ Seeding failed:', error);
    } finally {
        await session.close();
        await driver.close();
    }
}

seed();
