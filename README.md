# Network's Lifeline 🌐

An always-on, native Node.js agent for autonomous LAN device discovery and real-time health monitoring, paired with a lightweight vanilla JavaScript dashboard.

-----

## 🚀 About The Project

This project provides a robust solution for monitoring devices on a local area network (LAN) in real-time. It consists of two main components:

1.  **Node.js Agent**: A native, always-on service that runs on a machine within the network. It autonomously discovers connected devices using **nmap** and **parallel ICMP sweeps**. It then continuously monitors their status, batching and writing telemetry data (like Round-Trip Time) securely to **Cloud Firestore** using the Firebase Admin SDK.
2.  **Real-time Dashboard**: A lightweight, front-end dashboard built with **vanilla JavaScript**. It uses Firestore snapshot listeners to display the health and status of all discovered devices in real-time. You get instant insights into device health, RTT, and receive alerts when a device goes offline.

The core of this project is its efficiency and speed. By implementing features like heartbeat monitoring, customizable offline thresholds, and controlled-concurrency ping sweeps, the discovery and monitoring latency is reduced from minutes to near-real-time.

-----

### ✨ Features

  * **Autonomous Device Discovery**: Automatically discovers all devices on your local network using `nmap`.
  * **Real-time Health Monitoring**: Uses concurrent ICMP ping sweeps to monitor device uptime and Round-Trip Time (RTT) with minimal latency.
  * **Persistent & Secure Data**: Leverages the Firebase Admin SDK with service-account authentication to securely write sanitized telemetry to Cloud Firestore.
  * **Instant Alerts**: The dashboard provides immediate visual feedback for offline devices.
  * **Lightweight Dashboard**: A simple, no-framework, real-time dashboard built with vanilla JavaScript that listens for live updates from Firestore.
  * **Efficient & Scalable**: Employs batched writes and controlled concurrency to ensure the agent is efficient and doesn't overload the network.

-----

### 🛠️ Tech Stack

This project is built with a focus on performance and native capabilities.

  * **Backend Agent**:
      * [Node.js](https://nodejs.org/)
      * [nmap](https://nmap.org/) for network discovery
      * [ping](https://www.npmjs.com/package/ping) for ICMP sweeps
  * **Database & Authentication**:
      * [Firebase Admin SDK](https://firebase.google.com/docs/admin/setup)
      * [Cloud Firestore](https://firebase.google.com/docs/firestore)
  * **Frontend Dashboard**:
      * Vanilla JavaScript
      * HTML5 & CSS3

-----

## ⚙️ Getting Started

To get a local copy up and running, follow these simple steps.

### Prerequisites

  * **Node.js**: Make sure you have Node.js installed (v14 or higher).
    ```sh
    node -v
    ```
  * **Nmap**: The agent requires `nmap` to be installed on the host machine. You can download it from [nmap.org](https://nmap.org/download.html).
  * **Firebase Project**:
    1.  Create a new project on the [Firebase Console](https://console.firebase.google.com/).
    2.  Set up Cloud Firestore in your project.
    3.  Generate a private key file (service account credentials) for your project. Go to **Project Settings \> Service accounts** and click "Generate new private key".

### Installation

1.  **Clone the repo**:

    ```sh
    git clone https://github.com/Yesh287/Network-s-Lifeline.git
    cd Network-s-Lifeline
    ```

2.  **Install NPM packages for the agent**:

    ```sh
    cd agent
    npm install
    ```

3.  **Configure the Agent**:

      * Place the downloaded Firebase service account JSON file into the `agent/config` directory.
      * Rename the file to `serviceAccountKey.json`.
      * Open `agent/config/config.js` and update the `network` variable to your LAN's subnet (e.g., '192.168.1.0/24').

4.  **Configure the Dashboard**:

      * Navigate to the `dashboard` directory.
      * Open `dashboard/js/firebase-config.js`.
      * In your Firebase project settings, find your project's web app configuration details and paste them into this file.

-----

## ▶️ Usage

1.  **Run the Node.js Agent**:
    Navigate to the agent directory and start the monitoring service.

    ```sh
    cd agent
    node index.js
    ```

    The agent will start discovering and monitoring devices on your network.

2.  **View the Dashboard**:
    Open the `dashboard/index.html` file in your web browser to see the real-time status of your network devices.
