"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
var admin = require("firebase-admin");
var nmap = require("node-nmap");
var ping = require("ping");
var os_1 = require("os");
// Initialize Firebase Admin SDK
// This should be done securely, likely via environment variables or a service account file
// For now, a placeholder assuming credentials are provided via GOOGLE_APPLICATION_CREDENTIALS
var serviceAccount= require("../key.json");
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: serviceAccount.project_id,
});
var db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });
var AGENT_ID = process.env.AGENT_ID || 'local-agent-1'; // Unique ID for this agent instance
var HEARTBEAT_INTERVAL_MS = parseInt(process.env.HEARTBEAT_INTERVAL_MS || '60000', 10);
var OFFLINE_THRESHOLD_CHECKS = parseInt(process.env.OFFLINE_THRESHOLD_CHECKS || '3', 10);
var knownDevices = {};
function getLocalSubnet() {
    return __awaiter(this, void 0, void 0, function () {
        var interfaces, _i, _a, name_1, _b, _c, iface;
        return __generator(this, function (_d) {
            interfaces = (0, os_1.networkInterfaces)();
            for (_i = 0, _a = Object.keys(interfaces); _i < _a.length; _i++) {
                name_1 = _a[_i];
                for (_b = 0, _c = interfaces[name_1]; _b < _c.length; _b++) {
                    iface = _c[_b];
                    // Skip over internal (i.e. 127.0.0.1) and non-IPv4 addresses
                    if (iface.family === 'IPv4' && !iface.internal) {
                        return [2 /*return*/, { ip: iface.address, netmask: iface.netmask }];
                    }
                }
            }
            return [2 /*return*/, null];
        });
    });
}
function runNmapScan(subnet) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            console.log("Attempting nmap scan on " + subnet + "...");
            return [2 /*return*/, new Promise(function (resolve, reject) {
                    try {
                        var nmapScanner = new nmap.NmapScan(subnet, ["-sn"]);
                        nmapScanner.on("complete", function (report) {
                            resolve(report);
                        });
                        nmapScanner.on("error", function (err) {
                            console.warn("Nmap not found or permission denied, falling back to ping sweep:", err);
                            resolve([]);
                        });
                        nmapScanner.startScan();
                    }
                    catch (err) {
                        console.warn("Unexpected error:", err);
                        resolve([]);
                    }
                })];
        });
    });
}
function runPingSweep(subnet) {
  return __awaiter(this, void 0, void 0, function () {
    let ipParts, baseIp, hosts;
    return __generator(this, function (_a) {
      console.log(`Running ICMP ping sweep on ${subnet}... (parallel)`);

      ipParts = subnet.split(".");
      baseIp = ipParts.slice(0, 3).join(".");
      hosts = [];

      // Create a list of IPs
      const ips = Array.from({ length: 254 }, (_, i) => `${baseIp}.${i + 1}`);

      // Run pings in parallel, but limit concurrency
      const concurrency = 50; // number of pings at the same time
      const chunks = [];

      for (let i = 0; i < ips.length; i += concurrency) {
        chunks.push(ips.slice(i, i + concurrency));
      }

      return [2 /*return*/, (async () => {
        for (const chunk of chunks) {
          const results = await Promise.all(
            chunk.map(ip =>
              ping.promise.probe(ip).then(res => {
                if (res.alive) {
                  console.log(`Device found: ${ip} (RTT: ${res.avg}ms)`);
                  hosts.push({ ip, rtt: parseFloat(res.avg), hostname: res.host });
                }
              })
            )
          );
        }
        return hosts;
      })()];
    });
  });
}
function discoverDevices() {
    return __awaiter(this, void 0, void 0, function () {
        var subnetInfo, ip, netmask, subnetCidr, nmapResults, discoveredHosts, newDevices, batch, _i, discoveredHosts_1, host, deviceId, newDevice, deviceRef, existingDevice, updated, deviceRef, agentRef;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    console.log('Starting device discovery...');
                    return [4 /*yield*/, getLocalSubnet()];
                case 1:
                    subnetInfo = _a.sent();
                    if (!subnetInfo) {
                        console.error('Could not determine local subnet. Exiting discovery.');
                        return [2 /*return*/];
                    }
                    ip = subnetInfo.ip, netmask = subnetInfo.netmask;
                    subnetCidr = ip.split('.').slice(0, 3).join('.') + '.0/24';
                    console.log("Detected local IP: ".concat(ip, ", Netmask: ").concat(netmask, ". Scanning subnet: ").concat(subnetCidr));
                    console.log('CONSENT REQUIRED: Network scanning requires appropriate permissions. Please ensure you have consent to scan this network.');
                    return [4 /*yield*/, runNmapScan(subnetCidr)];
                case 2:
                    nmapResults = _a.sent();
                    discoveredHosts = [];
                    if (!(nmapResults.length > 0 && nmapResults[0].host)) return [3 /*break*/, 3];
                    // Process nmap results
                    discoveredHosts = nmapResults[0].host.map(function (host) { return ({
                        ip: host.address[0].item.addr,
                        mac: host.address[1] ? host.address[1].item.addr : undefined,
                        hostname: host.hostnames[0] ? host.hostnames[0].item.name : undefined,
                        rtt: host.times ? parseFloat(host.times[0].item.rttvar) : undefined, // rttvar is a good average
                    }); });
                    return [3 /*break*/, 5];
                case 3: return [4 /*yield*/, runPingSweep(subnetCidr)];
                case 4:
                    // Fallback to ping sweep if nmap didn't yield results or failed
                    discoveredHosts = _a.sent();
                    _a.label = 5;
                case 5:
                    newDevices = [];
                    batch = db.batch();
                    for (_i = 0, discoveredHosts_1 = discoveredHosts; _i < discoveredHosts_1.length; _i++) {
                        host = discoveredHosts_1[_i];
                        deviceId = host.mac || host.ip;
                        if (!knownDevices[deviceId]) {
                            newDevice = {
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
                            deviceRef = db.collection('devices').doc(deviceId);
                            batch.set(deviceRef, newDevice, { merge: true }); // Use merge to avoid overwriting if device exists
                        }
                        else {
                            existingDevice = knownDevices[deviceId];
                            updated = false;
                            if (host.mac && !existingDevice.mac) {
                                existingDevice.mac = host.mac;
                                updated = true;
                            }
                            if (host.hostname && !existingDevice.hostname) {
                                existingDevice.hostname = host.hostname;
                                updated = true;
                            }
                            if (updated) {
                                deviceRef = db.collection('devices').doc(deviceId);
                                batch.update(deviceRef, { mac: existingDevice.mac, hostname: existingDevice.hostname });
                            }
                        }
                    }
                    if (!(newDevices.length > 0)) return [3 /*break*/, 7];
                    console.log("Discovered and registered ".concat(newDevices.length, " new devices."));
                    return [4 /*yield*/, batch.commit()];
                case 6:
                    _a.sent();
                    return [3 /*break*/, 8];
                case 7:
                    console.log('No new devices discovered during this run.');
                    _a.label = 8;
                case 8:
                    agentRef = db.collection('agents').doc(AGENT_ID);
                    return [4 /*yield*/, agentRef.set({
                            agentId: AGENT_ID,
                            host: ip,
                            createdAt: admin.firestore.FieldValue.serverTimestamp(),
                            lastSeen: admin.firestore.FieldValue.serverTimestamp(),
                        }, { merge: true })];
                case 9:
                    _a.sent();
                    console.log('Device discovery complete.');
                    return [2 /*return*/];
            }
        });
    });
}
function heartbeatMonitor() {
    return __awaiter(this, void 0, void 0, function () {
        var _this = this;
        return __generator(this, function (_a) {
            console.log('Starting heartbeat monitoring...');
            setInterval(function () { return __awaiter(_this, void 0, void 0, function () {
                var batch, devicesToUpdate, _a, _b, _c, _i, deviceId, device, res, error_3, deviceId, deviceRef, agentRef;
                return __generator(this, function (_d) {
                    switch (_d.label) {
                        case 0:
                            console.log('Running heartbeat check...');
                            batch = db.batch();
                            devicesToUpdate = {};
                            _a = knownDevices;
                            _b = [];
                            for (_c in _a)
                                _b.push(_c);
                            _i = 0;
                            _d.label = 1;
                        case 1:
                            if (!(_i < _b.length)) return [3 /*break*/, 6];
                            _c = _b[_i];
                            if (!(_c in _a)) return [3 /*break*/, 5];
                            deviceId = _c;
                            device = knownDevices[deviceId];
                            _d.label = 2;
                        case 2:
                            _d.trys.push([2, 4, , 5]);
                            return [4 /*yield*/, ping.promise.probe(device.ip)];
                        case 3:
                            res = _d.sent();
                            if (res.alive) {
                                if (device.status === 'offline' || device.offlineChecks >= OFFLINE_THRESHOLD_CHECKS) {
                                    console.log("Device ".concat(device.ip, " is back online!"));
                                    devicesToUpdate[deviceId] = {
                                        status: 'online',
                                        lastSeen: admin.firestore.FieldValue.serverTimestamp(),
                                        rtt: parseFloat(res.avg),
                                        offlineChecks: 0, // Reset counter
                                    };
                                    device.status = 'online';
                                    device.offlineChecks = 0;
                                }
                                else {
                                    devicesToUpdate[deviceId] = {
                                        lastSeen: admin.firestore.FieldValue.serverTimestamp(),
                                        rtt: parseFloat(res.avg),
                                        offlineChecks: 0,
                                    };
                                    device.offlineChecks = 0;
                                }
                                device.rtt = parseFloat(res.avg);
                                device.lastSeen = admin.firestore.FieldValue.serverTimestamp(); // Update local copy
                            }
                            else {
                                device.offlineChecks = (device.offlineChecks || 0) + 1;
                                console.log("Device ".concat(device.ip, " not responding. Offline checks: ").concat(device.offlineChecks));
                                if (device.offlineChecks >= OFFLINE_THRESHOLD_CHECKS && device.status !== 'offline') {
                                    console.log("Device ".concat(device.ip, " marked as suspected offline."));
                                    devicesToUpdate[deviceId] = {
                                        status: 'offline',
                                        // lastSeen remains unchanged to indicate when it went offline
                                        offlineChecks: device.offlineChecks,
                                    };
                                    device.status = 'offline';
                                }
                                else {
                                    // Still incrementing local counter, but not updating status in DB yet
                                    devicesToUpdate[deviceId] = {
                                        offlineChecks: device.offlineChecks,
                                    };
                                }
                            }
                            return [3 /*break*/, 5];
                        case 4:
                            error_3 = _d.sent();
                            console.error("Error pinging ".concat(device.ip, ":"), error_3);
                            device.offlineChecks = (device.offlineChecks || 0) + 1;
                            console.log("Device ".concat(device.ip, " not responding due to error. Offline checks: ").concat(device.offlineChecks));
                            if (device.offlineChecks >= OFFLINE_THRESHOLD_CHECKS && device.status !== 'offline') {
                                console.log("Device ".concat(device.ip, " marked as suspected offline due to error."));
                                devicesToUpdate[deviceId] = {
                                    status: 'offline',
                                    offlineChecks: device.offlineChecks,
                                };
                                device.status = 'offline';
                            }
                            else {
                                devicesToUpdate[deviceId] = {
                                    offlineChecks: device.offlineChecks,
                                };
                            }
                            return [3 /*break*/, 5];
                        case 5:
                            _i++;
                            return [3 /*break*/, 1];
                        case 6:
                            for (deviceId in devicesToUpdate) {
                                deviceRef = db.collection('devices').doc(deviceId);
                                batch.update(deviceRef, devicesToUpdate[deviceId]);
                            }
                            if (!(Object.keys(devicesToUpdate).length > 0)) return [3 /*break*/, 8];
                            return [4 /*yield*/, batch.commit()];
                        case 7:
                            _d.sent();
                            console.log('Heartbeat updates committed to Firestore.');
                            return [3 /*break*/, 9];
                        case 8:
                            console.log('No device status changes to commit.');
                            _d.label = 9;
                        case 9:
                            agentRef = db.collection('agents').doc(AGENT_ID);
                            return [4 /*yield*/, agentRef.update({
                                    lastSeen: admin.firestore.FieldValue.serverTimestamp(),
                                })];
                        case 10:
                            _d.sent();
                            return [2 /*return*/];
                    }
                });
            }); }, HEARTBEAT_INTERVAL_MS);
            return [2 /*return*/];
        });
    });
}
function startAgent() {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    console.log('Starting device monitoring agent...');
                    // Initial discovery on startup
                    return [4 /*yield*/, discoverDevices()];
                case 1:
                    // Initial discovery on startup
                    _a.sent();
                    // Start continuous monitoring
                    return [4 /*yield*/, heartbeatMonitor()];
                case 2:
                    // Start continuous monitoring
                    _a.sent();
                    return [2 /*return*/];
            }
        });
    });
}
startAgent().catch(console.error);
