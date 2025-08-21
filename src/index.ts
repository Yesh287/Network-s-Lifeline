
import * as admin from 'firebase-admin';
import * as nmap from 'node-nmap';
import * as ping from 'ping';
import { networkInterfaces } from 'os';

// Initialize Firebase Admin SDK
// This should be done securely, likely via environment variables or a service account file
// For now, a placeholder assuming credentials are provided via GOOGLE_APPLICATION_CREDENTIALS
admin.initializeApp();
const db = admin.firestore();

const AGENT_ID = process.env.AGENT_ID || 'local-agent-1'; // Unique ID for this agent instance
const HEARTBEAT_INTERVAL_MS = parseInt(process.env.HEARTBEAT_INTERVAL_MS || '60000', 10);
const OFFLINE_THRESHOLD_CHECKS = parseInt(process.env.OFFLINE_THRESHOLD_CHECKS || '3', 10);

interface Device {
    deviceId: string;
    ip: string;
    mac?: string;
    hostname?: string;
    vendor?: string;
    ports?: number[];
    firstSeen: admin.firestore.FieldValue;
    lastSeen: admin.firestore.FieldValue;
    status: 'online' | 'offline' | 'unknown';
    rtt?: number;
    agentId: string;
    seenCount: number;
    offlineChecks?: number; // Local counter for consecutive offline checks
}

let knownDevices: { [ip: string]: Device } = {};

async function getLocalSubnet(): Promise<{ ip: string; netmask: string } | null> {
    const interfaces = networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]!) {
            // Skip over internal (i.e. 127.0.0.1) and non-IPv4 addresses
            if (iface.family === 'IPv4' && !iface.internal) {
                return { ip: iface.address, netmask: iface.netmask };
            }
        }
    }
    return null;
}

async function runNmapScan(subnet: string): Promise<any[]> {
    console.log(`Attempting nmap scan on ${subnet}...`);
    try {
        const nmapScanner = new nmap.NmapScan();
        nmapScanner.runnmap = 'nmap'; // Ensure nmap is found in PATH
        const report = await nmapScanner.scan(`-sn ${subnet}`);
        return report;
    } catch (error) {
        console.warn('Nmap not found or permission denied, falling back to ping sweep:', error);
        return [];
    }
}

async function runPingSweep(subnet: string): Promise<any[]> {
    console.log(`Running ICMP ping sweep on ${subnet}... (This might take a while for large subnets)`);
    const hosts: any[] = [];
    const ipParts = subnet.split('.');
    const baseIp = ipParts.slice(0, 3).join('.'); // Assuming /24 for simplicity for now

    for (let i = 1; i <= 254; i++) { // Iterate through common /24 subnet range
        const ip = `${baseIp}.${i}`;
        try {
            const res = await ping.promise.probe(ip);
            if (res.alive) {
                console.log(`Device found: ${ip} (RTT: ${res.avg}ms)`);
                hosts.push({ ip: ip, rtt: parseFloat(res.avg), hostname: res.host });
            }
        } catch (error) {
            // console.error(`Ping failed for ${ip}:`, error);
        }
    }
    return hosts;
}

async function discoverDevices() {
    console.log('Starting device discovery...');
    const subnetInfo = await getLocalSubnet();
    if (!subnetInfo) {
        console.error('Could not determine local subnet. Exiting discovery.');
        return;
    }

    const { ip, netmask } = subnetInfo;
    // Simple CIDR calculation for /24 based on IP for now
    const subnetCidr = ip.split('.').slice(0, 3).join('.') + '.0/24';

    console.log(`Detected local IP: ${ip}, Netmask: ${netmask}. Scanning subnet: ${subnetCidr}`);
    console.log('CONSENT REQUIRED: Network scanning requires appropriate permissions. Please ensure you have consent to scan this network.');

    // In a real scenario, you'd prompt the user here or check a config flag for consent.
    // For this prototype, we'll proceed for demonstration.
    const nmapResults = await runNmapScan(subnetCidr);
    let discoveredHosts: any[] = [];

    if (nmapResults.length > 0 && nmapResults[0].host) {
        // Process nmap results
        discoveredHosts = nmapResults[0].host.map((host: any) => ({
            ip: host.address[0].item.addr,
            mac: host.address[1] ? host.address[1].item.addr : undefined,
            hostname: host.hostnames[0] ? host.hostnames[0].item.name : undefined,
            rtt: host.times ? parseFloat(host.times[0].item.rttvar) : undefined, // rttvar is a good average
        }));
    } else {
        // Fallback to ping sweep if nmap didn't yield results or failed
        discoveredHosts = await runPingSweep(subnetCidr);
    }

    const newDevices: Device[] = [];
    const batch = db.batch();

    for (const host of discoveredHosts) {
        const deviceId = host.mac || host.ip; // Use MAC as deviceId if available, else IP
        if (!knownDevices[deviceId]) {
            const newDevice: Device = {
                deviceId: deviceId,
                agentId: AGENT_ID,
                ip: host.ip,
                mac: host.mac,
                hostname: host.hostname,
                rtt: host.rtt,
                firstSeen: admin.firestore.FieldValue.serverTimestamp(),
                lastSeen: admin.firestore.FieldValue.serverTimestamp(),
                status: 'online',
                seenCount: 1,
                offlineChecks: 0,
            };
            knownDevices[deviceId] = newDevice;
            newDevices.push(newDevice);

            const deviceRef = db.collection('devices').doc(deviceId);
            batch.set(deviceRef, newDevice, { merge: true }); // Use merge to avoid overwriting if device exists
        } else {
            // Update existing device with new info if discovery provides more details
            const existingDevice = knownDevices[deviceId];
            let updated = false;
            if (host.mac && !existingDevice.mac) { existingDevice.mac = host.mac; updated = true; }
            if (host.hostname && !existingDevice.hostname) { existingDevice.hostname = host.hostname; updated = true; }
            if (updated) {
                const deviceRef = db.collection('devices').doc(deviceId);
                batch.update(deviceRef, { mac: existingDevice.mac, hostname: existingDevice.hostname });
            }
        }
    }

    if (newDevices.length > 0) {
        console.log(`Discovered and registered ${newDevices.length} new devices.`);
        await batch.commit();
    } else {
        console.log('No new devices discovered during this run.');
    }

    // Register the agent itself
    const agentRef = db.collection('agents').doc(AGENT_ID);
    await agentRef.set({
        agentId: AGENT_ID,
        host: ip,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        lastSeen: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    console.log('Device discovery complete.');
}

async function heartbeatMonitor() {
    console.log('Starting heartbeat monitoring...');
    setInterval(async () => {
        console.log('Running heartbeat check...');
        const batch = db.batch();
        const devicesToUpdate: { [deviceId: string]: Partial<Device> } = {};

        for (const deviceId in knownDevices) {
            const device = knownDevices[deviceId];
            try {
                const res = await ping.promise.probe(device.ip);
                if (res.alive) {
                    if (device.status === 'offline' || device.offlineChecks! >= OFFLINE_THRESHOLD_CHECKS) {
                        console.log(`Device ${device.ip} is back online!`);
                        devicesToUpdate[deviceId] = {
                            status: 'online',
                            lastSeen: admin.firestore.FieldValue.serverTimestamp(),
                            rtt: parseFloat(res.avg),
                            offlineChecks: 0, // Reset counter
                        };
                        device.status = 'online';
                        device.offlineChecks = 0;
                    } else {
                        devicesToUpdate[deviceId] = {
                            lastSeen: admin.firestore.FieldValue.serverTimestamp(),
                            rtt: parseFloat(res.avg),
                            offlineChecks: 0,
                        };
                        device.offlineChecks = 0;
                    }
                    device.rtt = parseFloat(res.avg);
                    device.lastSeen = admin.firestore.FieldValue.serverTimestamp(); // Update local copy
                } else {
                    device.offlineChecks = (device.offlineChecks || 0) + 1;
                    console.log(`Device ${device.ip} not responding. Offline checks: ${device.offlineChecks}`);

                    if (device.offlineChecks! >= OFFLINE_THRESHOLD_CHECKS && device.status !== 'offline') {
                        console.log(`Device ${device.ip} marked as suspected offline.`);
                        devicesToUpdate[deviceId] = {
                            status: 'offline',
                            // lastSeen remains unchanged to indicate when it went offline
                            offlineChecks: device.offlineChecks,
                        };
                        device.status = 'offline';
                    } else {
                        // Still incrementing local counter, but not updating status in DB yet
                        devicesToUpdate[deviceId] = {
                            offlineChecks: device.offlineChecks,
                        };
                    }
                }
            } catch (error) {
                console.error(`Error pinging ${device.ip}:`, error);
                device.offlineChecks = (device.offlineChecks || 0) + 1;
                console.log(`Device ${device.ip} not responding due to error. Offline checks: ${device.offlineChecks}`);

                if (device.offlineChecks! >= OFFLINE_THRESHOLD_CHECKS && device.status !== 'offline') {
                    console.log(`Device ${device.ip} marked as suspected offline due to error.`);
                    devicesToUpdate[deviceId] = {
                        status: 'offline',
                        offlineChecks: device.offlineChecks,
                    };
                    device.status = 'offline';
                } else {
                    devicesToUpdate[deviceId] = {
                        offlineChecks: device.offlineChecks,
                    };
                }
            }
        }

        for (const deviceId in devicesToUpdate) {
            const deviceRef = db.collection('devices').doc(deviceId);
            batch.update(deviceRef, devicesToUpdate[deviceId]);
        }

        if (Object.keys(devicesToUpdate).length > 0) {
            await batch.commit();
            console.log('Heartbeat updates committed to Firestore.');
        } else {
            console.log('No device status changes to commit.');
        }

        // Update agent's lastSeen
        const agentRef = db.collection('agents').doc(AGENT_ID);
        await agentRef.update({
            lastSeen: admin.firestore.FieldValue.serverTimestamp(),
        });

    }, HEARTBEAT_INTERVAL_MS);
}

async function startAgent() {
    console.log('Starting device monitoring agent...');
    // Initial discovery on startup
    await discoverDevices();
    // Start continuous monitoring
    await heartbeatMonitor();
}

startAgent().catch(console.error);
