# Offloading Deepseek & Backend to Kali Linux

This guide explains how to offload the Pallas117/Gauss-Aurora backend and ML inference services to a remote Kali Linux machine (e.g., an old Dell XPS).

## Prerequisites

1.  **Kali Linux Node**: Ensure the machine is accessible via network (IP address required).
2.  **Node.js & Python**: Install Node.js (v20+) and Python 3.10+ on the Kali machine.
3.  **Dependencies**: Clone the repository and run `npm install` and `pip install -r requirements.txt` (if applicable) on the Kali machine.

## Kali Linux Configuration

### 1. Backend Service (`.env`)
Create/edit the `.env` file on the Kali machine:

```bash
PROXY_PORT=3001
PROXY_HOST=0.0.0.0  # Allow external connections
ALLOWED_ORIGINS=*    # Or your client machine's IP/port
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
LOCAL_INFER_URL=http://localhost:8000
```

### 2. Launch Services
Start the backend and ML inference server on the Kali machine:

```bash
# Start ML Inference Server
npm run dev:infer

# Start Backend Proxy
npm run dev:proxy
```

## Client Machine Configuration (Local)

Update your local `.env` file to point to the Kali Linux node:

```bash
VITE_HELIO_PROXY_URL=http://<KALI_IP>:3001
```

## Data Flow Visualization
Once configured, the **Data Flow HUD** in the UI will automatically detect the connectivity and visualize the "SDA Picture" for the demo, showing data moving from:
`SENSORS` -> `KALI NODE (Deepseek-R1)` -> `LOCAL HUD`
