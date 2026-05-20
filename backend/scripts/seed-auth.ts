import { auth } from "../better-auth.js";

async function seed() {
    console.log("Seeding initial better-auth operator account...");
    try {
        const user = await auth.api.signUpEmail({
            body: {
                email: "operator@gauss.space",
                password: "skunkworks-alpha",
                name: "Lead Operator"
            }
        });
        console.log("✅ Successfully created: operator@gauss.space");
        console.log("🔑 Passkey: skunkworks-alpha");
    } catch (e) {
        console.log("Error creating user (or already exists):", e);
    }
    process.exit(0);
}

seed();
