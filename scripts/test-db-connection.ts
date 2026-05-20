// scripts/test-db-connection.ts
import { GraphDBClient } from '../backend/services/graphdb-client';

async function main() {
  const client = new GraphDBClient();
  
  try {
    console.log("Attempting to connect to Neo4j...");
    
    // Test injection
    await client.injectFact(
      { id: 'TEST_NODE_A', label: 'Test', properties: { val: 1 } },
      { sourceId: 'TEST_NODE_A', targetId: 'TEST_NODE_B', type: 'CAUSES', properties: {} },
      { id: 'TEST_NODE_B', label: 'Test', properties: { val: 2 } }
    );
    
    // Test trace
    const trace = await client.traceAnomalyPath('TEST_NODE_A');
    console.log("Trace result:", JSON.stringify(trace, null, 2));
    
    if (trace.nodes.length > 0) {
      console.log("Verification SUCCESS: Graph connection is live and queryable.");
    } else {
      console.error("Verification FAILURE: No nodes returned in trace.");
    }

  } catch (error) {
    console.error("Verification FAILURE: Could not connect to Neo4j.", error);
  } finally {
    await client.close();
  }
}

main();
