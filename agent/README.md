# Local Agent

This is the local agent responsible for discovering devices on the local subnet, continuously monitoring their liveness, and reporting their status to the Firebase backend.

## Table of Contents

-   [Features](#features)
-   [Prerequisites](#prerequisites)
-   [Configuration](#configuration)
-   [Running the Agent](#running-the-agent)
    -   [Locally](#locally)
    -   [Using Docker](#using-docker)
-   [Environment Variables](#environment-variables)

## Features

-   **Initial Discovery:** On first run, it detects the local subnet and performs a sweep to discover active devices.
    -   Uses `nmap -sn` if `nmap` is installed and permissions allow, otherwise falls back to a conservative ICMP ping sweep.
    -   Captures IP, MAC address (if possible), hostname, and RTT/latency.
-   **Heartbeat Monitoring:** Periodically pings/traces known devices and updates their `lastSeen` timestamp and `rtt` in the Firebase backend.
-   **Offline Detection:** If a device does not respond for a configurable number of consecutive checks, it marks the device as `suspectedOffline` locally and the backend will eventually mark it as `offline`.
-   **Firebase Integration:** Communicates with Firestore to register devices and send heartbeat updates.
-   **Consent Prompt:** Requires explicit user consent before performing network scans.

## Prerequisites

-   Node.js (v18 or higher) for local execution.
-   npm (Node Package Manager).
-   Docker (if running via Docker).
-   **Firebase Project:**
    -   A Firebase project configured with Firestore.
    -   A Firebase Service Account Key JSON file. This file grants the agent permissions to write to your Firestore database. **Keep this file secure and do not commit it to version control.**

## Configuration

1.  **Firebase Service Account Key:**
    -   Go to your Firebase Project settings -> Service accounts.
    -   Click on "Generate new private key" and download the JSON file.
    -   Rename this file (e.g., to `serviceAccountKey.json`) and place it in a secure location on the machine where the agent will run.
    -   When running the agent, you'll need to point the `GOOGLE_APPLICATION_CREDENTIALS` environment variable to this file.

2.  **Environment Variables:** Configure the agent using the following environment variables:
    -   `AGENT_ID`: (Optional) A unique identifier for this agent instance. Defaults to the machine's sanitized hostname.
    -   `HEARTBEAT_INTERVAL_MS`: (Optional) The interval in milliseconds between device heartbeat checks. Default: `60000` (60 seconds).
    -   `OFFLINE_THRESHOLD_CHECKS`: (Optional) The number of consecutive failed checks before a device is considered potentially offline by the agent. Default: `3`.

## Running the Agent

### Locally

1.  **Navigate to the agent directory:**
    ```bash
    cd agent
    ```

2.  **Install dependencies:**
    ```bash
    npm install
    ```

3.  **Set the Firebase credentials environment variable:**
    Replace `/path/to/your/serviceAccountKey.json` with the actual path to your downloaded Firebase Service Account Key JSON file.

    **Linux/macOS:**
    ```bash
    export GOOGLE_APPLICATION_CREDENTIALS="/path/to/your/serviceAccountKey.json"
    ```

    **Windows (Command Prompt):**
    ```bash
    set GOOGLE_APPLICATION_CREDENTIALS="C:\path\to\your\serviceAccountKey.json"
    ```

    **Windows (PowerShell):**
    ```powershell
    $env:GOOGLE_APPLICATION_CREDENTIALS="C:\path\to\your\serviceAccountKey.json"
    ```

4.  **Run the agent:**
    ```bash
    npm start
    ```
    The agent will prompt you for consent to scan the network. Type `yes` and press Enter to proceed.

### Using Docker

1.  **Navigate to the agent directory:**
    ```bash
    cd agent
    ```

2.  **Build the Docker image:**
    ```bash
    docker build -t local-agent .
    ```

3.  **Run the Docker container:**
    You need to mount your `serviceAccountKey.json` into the container and set the `GOOGLE_APPLICATION_CREDENTIALS` environment variable to point to its location *inside the container*. You also need to run the container in `host` network mode so it can scan the local subnet.

    Replace `/path/to/your/serviceAccountKey.json` with the actual path on your host machine.

    ```bash
    docker run --network=host \
      -e GOOGLE_APPLICATION_CREDENTIALS="/app/serviceAccountKey.json" \
      -v /path/to/your/serviceAccountKey.json:/app/serviceAccountKey.json \
      -it local-agent
    ```
    The `-it` flag ensures interactive mode, allowing you to respond to the consent prompt. For unattended runs (e.g., in a production setup), you would need to pre-configure consent or auto-approve based on your security policies.

## Environment Variables

| Variable                 | Description                                                                                                                                                                                                                                                                                                                                   | Default      |
| :----------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------- |
| `AGENT_ID`               | A unique identifier for this agent instance. This will be used as the document ID in the `agents` Firestore collection.                                                                                                                                                                                                                              | `os.hostname()` (sanitized) |
| `HEARTBEAT_INTERVAL_MS`  | The interval (in milliseconds) at which the agent performs heartbeat checks on known devices and reports their status to Firebase.                                                                                                                                                                                                                    | `60000` (60 seconds) |
| `OFFLINE_THRESHOLD_CHECKS` | The number of consecutive failed ping checks for a device before the agent considers it potentially offline. The backend Cloud Function then uses its own threshold (based on `lastSeen`) to officially mark the device offline and trigger alerts.                                                                                                 | `3`          |
| `GOOGLE_APPLICATION_CREDENTIALS` | **Required.** The absolute path to your Firebase Service Account Key JSON file. This environment variable is used by the Firebase Admin SDK to authenticate your agent with your Firebase project.                                                                                                                                                                            | None         |
