const admin = require('firebase-admin');
const ping = require('ping');
const { exec } = require('child_process');
const os = require('os');
const readline = require('readline');

// Initialize Firebase Admin SDK
try {
    var serviceAccount = require("./sec.json");

    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
} catch (e) {
    console.error("Error initializing Firebase Admin SDK. Make sure GOOGLE_APPLICATION_CREDENTIALS is set or service account key is provided.", e);
    process.exit(1);
}
const db = admin.firestore();

const AGENT_ID = process.env.AGENT_ID || os.hostname().replace(/[^a-zA-Z0-9]/g, '-');
const HEARTBEAT_INTERVAL_MS = parseInt(process.env.HEARTBEAT_INTERVAL_MS || '60000', 10);
const OFFLINE_THRESHOLD_CHECKS = parseInt(process.env.OFFLINE_THRESHOLD_CHECKS || '3', 10);

console.log(`Agent ID: ${AGENT_ID}`);
console.log(`Heartbeat Interval: ${HEARTBEAT_INTERVAL_MS / 1000} seconds`);

const discoveredDevices = new Map();

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
        // Use a command that works on both Windows and Unix-like systems
        const command = os.platform() === 'win32' ? 'where nmap' : 'which nmap';
        exec(command, (error) => {
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
    const octets = networkAddress.split('.').map(Number);

    const ipsToScan = [];
    if (parseInt(cidr, 10) === 24) {
        for (let i = 1; i <= 254; i++) {
            ipsToScan.push(`${octets[0]}.${octets[1]}.${octets[2]}.${i}`);
        }
    } else {
        console.warn('Ping sweep currently only fully implemented for /24 subnets. Scanning a limited range.');
        ipsToScan.push(networkAddress.substring(0, networkAddress.lastIndexOf('.') + 1) + '1');
        ipsToScan.push(networkAddress.substring(0, networkAddress.lastIndexOf('.') + 1) + '10');
        ipsToScan.push(networkAddress.substring(0, networkAddress.lastIndexOf('.') + 1) + '100');
    }

    // Create an array of promises to run pings concurrently
    const promises = ipsToScan.map(ip => ping.promise.probe(ip, { timeout: 2 }));

    // Wait for all pings to complete
    const responses = await Promise.all(promises);

    const results = [];
    for (const res of responses) {
        if (res.alive) {
            console.log(`Found device: ${res.host} (RTT: ${res.avg}ms)`);
            results.push({ ip: res.host, rtt: parseFloat(res.avg) });
        }
    }
    return results;
}

/**
 * Performs nmap scan on the given subnet.
 * @param {string} subnetCidr e.g., '192.168.1.0/24'
 * @returns {Promise<Array<object>>} Array of discovered devices { ip, mac, hostname, rtt }.
 */
async function nmapScan(subnetCidr) {
    console.log(`Performing nmap scan on ${subnetCidr}...`);
    return new Promise(resolve => {
        exec(`nmap -sn -T4 ${subnetCidr} -oG -`, (error, stdout, stderr) => {
            if (error) {
                console.error(`nmap error: ${error.message}`);
                console.error(`nmap stderr: ${stderr}`);
                resolve([]);
                return;
            }
            const devices = [];
            const lines = stdout.split('\n');
            lines.forEach(line => {
                if (line.startsWith('Host:') && line.includes('Status: Up')) {
                    const ipMatch = line.match(/Host: ([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})/);
                    const hostnameMatch = line.match(/\((.*?)\)/);
                    const macMatch = line.match(/MAC Address: ([0-9A-F:]{17})/);

                    if (ipMatch) {
                        const ip = ipMatch[1];
                        const hostname = hostnameMatch ? hostnameMatch[1] : ip;
                        const mac = macMatch ? macMatch[1] : 'unknown';
                        
                        // RTT isn't reliably available in nmap's greppable output for -sn scans
                        // We'll rely on the ping sweep for this or set it to 0
                        devices.push({ ip, mac, hostname, rtt: 0 });
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

    console.log('Registering devices with Firebase...');
    const batch = db.batch();
    const agentRef = db.collection('agents').doc(AGENT_ID);

    batch.set(agentRef, {
        agentId: AGENT_ID,
        host: os.hostname(),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        lastSeen: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    for (const device of discovered) {
        const deviceId = device.mac && device.mac !== 'unknown' ? device.mac.replace(/:/g, '').toLowerCase() : device.ip.replace(/\./g, '');
        const deviceRef = db.collection('devices').doc(deviceId);

        const deviceData = {
            deviceId: deviceId,
            agentId: AGENT_ID,
            ip: device.ip,
            mac: device.mac || 'unknown',
            hostname: device.hostname || device.ip,
            vendor: 'unknown',
            ports: [],
            firstSeen: admin.firestore.FieldValue.serverTimestamp(),
            lastSeen: admin.firestore.FieldValue.serverTimestamp(),
            status: 'online',
            rtt: device.rtt,
            seenCount: 1,
            offlineChecks: 0,
        };
        batch.set(deviceRef, deviceData, { merge: true });
        discoveredDevices.set(deviceId, deviceData);
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
            const res = await ping.promise.probe(deviceData.ip, { timeout: 10 });

            const deviceRef = db.collection('devices').doc(deviceId);
            const currentDeviceDoc = await deviceRef.get();
            const currentDeviceData = currentDeviceDoc.data();

            let newOfflineChecks = currentDeviceData?.offlineChecks || 0;
            let newStatus = currentDeviceData?.status || 'unknown';

            if (res.alive) {
                newOfflineChecks = 0;
                newStatus = 'online';
                if (currentDeviceData?.status === 'offline') {
                    console.log(`Device ${deviceData.ip} is back online.`);
                }
            } else {
                newOfflineChecks++;
                console.log(`Device ${deviceData.ip} failed ping. Offline checks: ${newOfflineChecks}`);
                if (newOfflineChecks >= OFFLINE_THRESHOLD_CHECKS) {
                    newStatus = 'offline';
                    if (currentDeviceData?.status !== 'offline') {
                        console.log(`Device ${deviceData.ip} is now offline.`);
                    }
                }
            }

            await deviceRef.update({
                lastSeen: admin.firestore.FieldValue.serverTimestamp(),
                rtt: res.avg ? parseFloat(res.avg) : 0,
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
