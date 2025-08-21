const admin = require('firebase-admin');
const ping = require('node-ping');
const { exec } = require('child_process');
const os = require('os');
const readline = require('readline');

// Initialize Firebase Admin SDK
// Make sure to set GOOGLE_APPLICATION_CREDENTIALS environment variable
// or provide a service account key file path directly.
// For Docker, you might mount the key file into the container.
// For local testing, ensure your Firebase project is set up and service account key is downloaded.
try {
    admin.initializeApp();
} catch (e) {
    console.error("Error initializing Firebase Admin SDK. Make sure GOOGLE_APPLICATION_CREDENTIALS is set or service account key is provided.", e);
    process.exit(1);
}
const db = admin.firestore();

const AGENT_ID = process.env.AGENT_ID || os.hostname().replace(/[^a-zA-Z0-9]/g, '-'); // Use hostname as agent ID, sanitize it
const HEARTBEAT_INTERVAL_MS = parseInt(process.env.HEARTBEAT_INTERVAL_MS || '60000', 10); // Default 60 seconds
const OFFLINE_THRESHOLD_CHECKS = parseInt(process.env.OFFLINE_THRESHOLD_CHECKS || '3', 10); // Default 3 checks

console.log(`Agent ID: ${AGENT_ID}`);
console.log(`Heartbeat Interval: ${HEARTBEAT_INTERVAL_MS / 1000} seconds`);

const discoveredDevices = new Map(); // Map to store devices: deviceId -> { ip, mac, hostname, ... }

/**
 * Prompts the user for consent to perform network scanning.
 * @returns {Promise<boolean>} True if consent is given, false otherwise.
 */
async function promptForConsent() {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    return new Promise((resolve) => {
        rl.question('This agent needs to scan your local network to discover devices. Do you consent? (yes/no): ', (answer) => {
            rl.close();
            resolve(answer.toLowerCase() === 'yes');
        });
    });
}

/**
 * Discovers local IP and subnet mask.
 * @returns {object|null} { ip, netmask, cidr } or null if not found.
 */
function getLocalNetworkInfo() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            // Skip over internal (i.e. 127.0.0.1) and non-IPv4 addresses
            if (iface.family === 'IPv4' && !iface.internal) {
                const ip = iface.address;
                const netmask = iface.netmask;
                const parts = netmask.split('.');
                let cidr = 0;
                for (let i = 0; i < parts.length; i++) {
                    cidr += (parseInt(parts[i], 10) >>> 0).toString(2).split('1').length - 1;
                }
                return { ip, netmask, cidr };
            }
        }
    }
    return null;
}

/**
 * Checks if nmap is installed.
 * @returns {Promise<boolean>} True if nmap is found, false otherwise.
 */
async function hasNmap() {
    return new Promise(resolve => {
        exec('which nmap', (error) => {
            if (error) {
                console.log('nmap not found. Falling back to ICMP ping sweep.');
                resolve(false);
            } else {
                console.log('nmap found. Will attempt to use for discovery.');
                resolve(true);
            }
        });
    });
}

/**
 * Performs a ping sweep on the given subnet.
 * @param {string} subnetCidr e.g., '192.168.1.0/24'
 * @returns {Promise<Array<object>>} Array of discovered devices { ip, rtt }.
 */
async function pingSweep(subnetCidr) {
    console.log(`Performing ICMP ping sweep on ${subnetCidr}...`);
    const [networkAddress, cidr] = subnetCidr.split('/');
    const numHosts = Math.pow(2, (32 - parseInt(cidr, 10))) - 2; // Subtract network and broadcast address
    const octets = networkAddress.split('.').map(Number);

    // Simple IP incrementer for /24
    const ipsToScan = [];
    if (parseInt(cidr, 10) === 24) {
        for (let i = 1; i <= 254; i++) { // Scan .1 to .254
            ipsToScan.push(`${octets[0]}.${octets[1]}.${octets[2]}.${i}`);
        }
    } else {
        console.warn('Ping sweep currently only fully implemented for /24 subnets. Scanning a limited range.');
        // Fallback for other CIDRs: just scan a few common IPs or adjust logic
        // This is a simplification for the prototype.
        ipsToScan.push(networkAddress.substring(0, networkAddress.lastIndexOf('.') + 1) + '1'); // Gateway
        ipsToScan.push(networkAddress.substring(0, networkAddress.lastIndexOf('.') + 1) + '10');
        ipsToScan.push(networkAddress.substring(0, networkAddress.lastIndexOf('.') + 1) + '100');
        // Add more ips based on your specific needs for other subnets
    }

    const results = [];
    const promises = ipsToScan.map(ip => {
        return new Promise(resolve => {
            const start = Date.now();
            ping.ping(ip, { timeout: 1000 }, (err, data) => {
                if (data && data.alive) {
                    const rtt = Date.now() - start;
                    console.log(`Found device: ${ip} (RTT: ${rtt}ms)`);
                    results.push({ ip, rtt });
                }
                resolve();
            });
        });
    });

    await Promise.all(promises);
    return results;
}

/**
 * Performs nmap scan on the given subnet.
 * @param {string} subnetCidr e.g., '192.168.1.0/24'
 * @returns {Promise<Array<object>>} Array of discovered devices { ip, mac, hostname, openPorts, rtt }.
 */
async function nmapScan(subnetCidr) {
    console.log(`Performing nmap scan on ${subnetCidr}...`);
    return new Promise(resolve => {
        // -sn: Ping Scan - disable port scan
        // -T4: Aggressive timing (adjust if needed for network sensitivity)
        // -oG -: Greppable output to stdout
        exec(`nmap -sn -T4 ${subnetCidr} -oG -`, (error, stdout, stderr) => {
            if (error) {
                console.error(`nmap error: ${error.message}`);
                console.error(`nmap stderr: ${stderr}`);
                resolve([]); // Return empty on error
                return;
            }
            const devices = [];
            const lines = stdout.split('\n');
            lines.forEach(line => {
                if (line.startsWith('Host:') && line.includes('Status: Up')) {
                    const ipMatch = line.match(/Host: ([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})/);
                    const hostnameMatch = line.match(/Host: .*\(([a-zA-Z0-9\.-]+)\)/);
                    const macMatch = line.match(/MAC: ([0-9A-Fa-f:]{17})/);
                    const rttMatch = line.match(/RTT: ([0-9\.]+)ms/);

                    if (ipMatch) {
                        const ip = ipMatch[1];
                        const hostname = hostnameMatch ? hostnameMatch[1] : ip;
                        const mac = macMatch ? macMatch[1] : 'unknown';
                        const rtt = rttMatch ? parseFloat(rttMatch[1]) : 0; // nmap gives RTT for ping scan

                        devices.push({ ip, mac, hostname, rtt });
                    }
                }
            });
            console.log(`nmap discovered ${devices.length} devices.`);
            resolve(devices);
        });
    });
}

/**
 * Performs initial device discovery.
 */
async function discoverDevices() {
    const consentGiven = await promptForConsent();
    if (!consentGiven) {
        console.log('Network scanning consent denied. Exiting.');
        process.exit(0);
    }

    const networkInfo = getLocalNetworkInfo();
    if (!networkInfo) {
        console.error('Could not determine local network information. Exiting.');
        process.exit(1);
    }

    const subnetCidr = `${networkInfo.ip.substring(0, networkInfo.ip.lastIndexOf('.') + 1)}0/${networkInfo.cidr}`;
    console.log(`Local network: ${networkInfo.ip}, Subnet: ${subnetCidr}`);

    let discovered = [];
    const nmapAvailable = await hasNmap();

    if (nmapAvailable) {
        discovered = await nmapScan(subnetCidr);
    } else {
        discovered = await pingSweep(subnetCidr);
    }

    // Register discovered devices with Firebase
    console.log('Registering devices with Firebase...');
    const batch = db.batch();
    const agentRef = db.collection('agents').doc(AGENT_ID);
    
    // Update agent lastSeen and host info
    batch.set(agentRef, {
        agentId: AGENT_ID,
        host: os.hostname(),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        lastSeen: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    for (const device of discovered) {
        const deviceId = device.mac && device.mac !== 'unknown' ? device.mac.replace(/:/g, '').toLowerCase() : device.ip.replace(/\./g, ''); // Use MAC as ID, fallback to IP without dots
        const deviceRef = db.collection('devices').doc(deviceId);
        
        const deviceData = {
            deviceId: deviceId,
            agentId: AGENT_ID,
            ip: device.ip,
            mac: device.mac || 'unknown',
            hostname: device.hostname || device.ip,
            vendor: 'unknown', // Best-effort for MAC OUI - can be implemented later
            ports: [], // Nmap full scan would populate this
            firstSeen: admin.firestore.FieldValue.serverTimestamp(),
            lastSeen: admin.firestore.FieldValue.serverTimestamp(),
            status: 'online',
            rtt: device.rtt,
            seenCount: 1,
            offlineChecks: 0,
        };
        batch.set(deviceRef, deviceData, { merge: true }); // Use merge: true for idempotent updates
        discoveredDevices.set(deviceId, deviceData); // Add to local map
    }

    try {
        await batch.commit();
        console.log(`Successfully registered ${discovered.length} devices.`);
    } catch (error) {
        console.error('Error registering devices:', error);
    }
}

/**
 * Performs periodic heartbeat checks for known devices.
 */
async function sendHeartbeats() {
    console.log('Sending heartbeats...');
    const agentRef = db.collection('agents').doc(AGENT_ID);
    await agentRef.update({ lastSeen: admin.firestore.FieldValue.serverTimestamp() });

    for (const [deviceId, deviceData] of discoveredDevices.entries()) {
        try {
            const start = Date.now();
            const res = await new Promise(resolve => {
                ping.ping(deviceData.ip, { timeout: 1000 }, (err, data) => {
                    if (err) {
                        console.error(`Ping error for ${deviceData.ip}: ${err.message}`);
                        resolve({ alive: false, rtt: 0 });
                    } else {
                        resolve(data);
                    }
                });
            });
            const rtt = res.alive ? (Date.now() - start) : 0;

            const deviceRef = db.collection('devices').doc(deviceId);
            const currentDeviceDoc = await deviceRef.get();
            const currentDeviceData = currentDeviceDoc.data();

            let newOfflineChecks = currentDeviceData?.offlineChecks || 0;
            let newStatus = currentDeviceData?.status || 'unknown';

            if (res.alive) {
                newOfflineChecks = 0; // Reset checks if device is alive
                newStatus = 'online';
                if (currentDeviceData.status === 'offline') {
                    console.log(`Device ${deviceData.ip} is back online.`);
                }
            } else {
                newOfflineChecks++;
                console.log(`Device ${deviceData.ip} failed ping. Offline checks: ${newOfflineChecks}`);
                if (newOfflineChecks >= OFFLINE_THRESHOLD_CHECKS) {
                    newStatus = 'offline';
                    if (currentDeviceData.status !== 'offline') {
                        console.log(`Device ${deviceData.ip} is now offline.`);
                    }
                }
            }
            
            await deviceRef.update({
                lastSeen: admin.firestore.FieldValue.serverTimestamp(),
                rtt: rtt,
                status: newStatus,
                offlineChecks: newOfflineChecks,
            });
        } catch (error) {
            console.error(`Error updating heartbeat for ${deviceData.ip}:`, error);
        }
    }
    console.log('Heartbeats sent.');
}

// Main agent loop
async function startAgent() {
    await discoverDevices();
    setInterval(sendHeartbeats, HEARTBEAT_INTERVAL_MS);
}

startAgent();