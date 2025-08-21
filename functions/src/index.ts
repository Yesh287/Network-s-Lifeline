import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { CallableRequest } from 'firebase-functions/v2/https';

// Import SendGrid if you decide to implement email alerts
// import * as sgMail from '@sendgrid/mail';

admin.initializeApp();
const db = admin.firestore();

// Configure SendGrid API Key (if using email alerts)
// const SENDGRID_API_KEY = functions.config().sendgrid?.key;
// if (SENDGRID_API_KEY) {
//     sgMail.setApiKey(SENDGRID_API_KEY);
// }

// Helper to send FCM notifications
async function sendFCMNotification(token: string, title: string, body: string, data?: { [key: string]: string }) {
    const message = {
        notification: { title, body },
        data: data,
        token: token,
    };
    try {
        await admin.messaging().send(message);
        console.log('FCM notification sent successfully to:', token);
    } catch (error) {
        console.error('Error sending FCM notification to', token, ':', error);
    }
}

/**
 * Cloud Function to handle device registration and updates.
 * This function is triggered when a device document is created or updated.
 * It ensures firstSeen is set and manages agent lastSeen.
 */
export const onDeviceWrite = onDocumentWritten('devices/{deviceId}', async (event) => {
    const deviceData = event.data?.after.data();
    const previousDeviceData = event.data?.before.data();

    if (!deviceData) {
        console.log('Device deleted, no action needed.');
        return null;
    }

    const deviceId = event.params.deviceId;
    const agentId = deviceData.agentId;

    // Update agent's lastSeen timestamp whenever one of its devices is updated
    if (agentId) {
        const agentRef = db.collection('agents').doc(agentId);
        await agentRef.set({
            lastSeen: admin.firestore.FieldValue.serverTimestamp(),
            // Also add agentId and host on initial creation if not present
            agentId: agentId, // Ensure agentId is set
            host: deviceData.agentHost || 'unknown', // Assuming agentHost might come from agent's initial registration
        }, { merge: true });
    }

    // Handle new device registration (firstSeen)
    if (!previousDeviceData || !previousDeviceData.firstSeen) {
        if (!deviceData.firstSeen) {
            console.log(`Setting firstSeen for new device: ${deviceId}`);
            await event.data.after.ref.set({
                firstSeen: admin.firestore.FieldValue.serverTimestamp(),
                status: deviceData.status || 'online', // Default status for new devices
                seenCount: 1,
                offlineChecks: 0,
            }, { merge: true });
        }
    }

    // Offline detection logic
    // This part is crucial for status changes and alert generation
    const heartbeatIntervalMs = parseInt(process.env.HEARTBEAT_INTERVAL_MS || '60000', 10);
    const offlineThresholdChecks = parseInt(process.env.OFFLINE_THRESHOLD_CHECKS || '3', 10);
    // The backend calculates status=offline if now - lastSeen > offlineThreshold (configurable; default 3 * heartbeatInterval).
    const offlineThresholdMs = offlineThresholdChecks * heartbeatIntervalMs;

    const lastSeenMs = deviceData.lastSeen?.toMillis();
    const nowMs = Date.now();

    if (lastSeenMs && (nowMs - lastSeenMs > offlineThresholdMs)) {
        // Device is considered offline by backend logic
        if (deviceData.status === 'online') {
            console.log(`Device ${deviceId} (IP: ${deviceData.ip}) is now offline.`);

            // Update device status to offline in Firestore
            await event.data.after.ref.update({ status: 'offline' });

            // Create an alert document
            const alertMessage = `Device ${deviceData.hostname || deviceData.ip} went offline.`;
            await db.collection('alerts').add({
                deviceId: deviceId,
                agentId: agentId,
                type: 'offline',
                message: alertMessage,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                acknowledged: false,
            });

            // Send push notifications to relevant users
            const usersSnapshot = await db.collection('users').get();
            usersSnapshot.forEach(async (doc) => {
                const userData = doc.data();
                if (userData.notificationTokens && userData.notificationTokens.length > 0) {
                    for (const token of userData.notificationTokens) {
                        await sendFCMNotification(token, 'Device Offline', alertMessage, { deviceId: deviceId, type: 'offline' });
                    }
                }
                // Optional: Send email notification
                // if (userData.email && SENDGRID_API_KEY) {
                //     const msg = {
                //         to: userData.email,
                //         from: 'noreply@yourdomain.com', // Replace with your verified SendGrid sender
                //         subject: 'Device Offline Alert',
                //         text: alertMessage,
                //         html: `<strong>${alertMessage}</strong><p>Device IP: ${deviceData.ip}</p>`, // Basic HTML
                //     };
                //     try {
                //         await sgMail.send(msg);
                //         console.log('Email sent to:', userData.email);
                //     } catch (emailError) {
                //         console.error('Error sending email:', emailError);
                //     }
                // }
            });
        }
    } else if (deviceData.status === 'offline' && lastSeenMs && (nowMs - lastSeenMs <= offlineThresholdMs)) {
        // Device was offline but now its lastSeen is recent, meaning it's back online
        console.log(`Device ${deviceId} (IP: ${deviceData.ip}) is back online.`);
        await event.data.after.ref.update({ status: 'online' });

        // Optionally, create an 'online' alert or clear previous alerts
        const alertMessage = `Device ${deviceData.hostname || deviceData.ip} is back online.`;
        await db.collection('alerts').add({
            deviceId: deviceId,
            agentId: agentId,
            type: 'online',
            message: alertMessage,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            acknowledged: false,
        });

        const usersSnapshot = await db.collection('users').get();
        usersSnapshot.forEach(async (doc) => {
            const userData = doc.data();
            if (userData.notificationTokens && userData.notificationTokens.length > 0) {
                for (const token of userData.notificationTokens) {
                    await sendFCMNotification(token, 'Device Online', alertMessage, { deviceId: deviceId, type: 'online' });
                }
            }
        });
    }

    return null;
});


/**
 * Callable Cloud Function for agents to register themselves and a batch of devices.
 * This provides a more controlled API endpoint for the agent.
 * NOTE: For production, this should be secured with proper authentication (e.g., Firebase Auth with custom tokens or App Check).
 * For this prototype, we'll assume the Firestore rules handle basic agent auth.
 */
// export const registerAgentAndDevices = functions.https.onCall(async (data, context) => {
//     // Ensure the request is authenticated if required
//     // if (!context.auth) {
//     //     throw new functions.https.HttpsError('unauthenticated', 'The function must be called while authenticated.');
//     // }

//     const { agentId, agentHost, devices } = data;

//     if (!agentId || !devices || !Array.isArray(devices)) {
//         throw new functions.https.HttpsError('invalid-argument', 'Missing agentId or devices array.');
//     }

//     const batch = db.batch();

//     // Register/update agent document
//     const agentRef = db.collection('agents').doc(agentId);
//     batch.set(agentRef, {
//         agentId: agentId,
//         host: agentHost || 'unknown',
//         createdAt: admin.firestore.FieldValue.serverTimestamp(),
//         lastSeen: admin.firestore.FieldValue.serverTimestamp(),
//     }, { merge: true });

//     // Add/update device documents
//     for (const device of devices) {
//         const deviceRef = db.collection('devices').doc(device.deviceId);
//         batch.set(deviceRef, {
//             ...device,
//             agentId: agentId,
//             firstSeen: admin.firestore.FieldValue.serverTimestamp(), // Set or update firstSeen
//             lastSeen: admin.firestore.FieldValue.serverTimestamp(),
//             status: device.status || 'online',
//             seenCount: (device.seenCount || 0) + 1,
//             offlineChecks: 0,
//         }, { merge: true });
//     }

//     try {
//         await batch.commit();
//         return { status: 'success', message: 'Agent and devices registered/updated successfully.' };
//     } catch (error) {
//         console.error('Error registering agent and devices:', error);
//         throw new functions.https.HttpsError('internal', 'Failed to register agent and devices.', error);
//     }
// });


/**
 * Callable Cloud Function for agents to send heartbeat updates for devices.
 * Similar to register, this would be secured in production.
 */
// export const sendDeviceHeartbeat = functions.https.onCall(async (data, context) => {
//     // if (!context.auth) {
//     //     throw new functions.https.HttpsError('unauthenticated', 'The function must be called while authenticated.');
//     // }

//     const { agentId, deviceUpdates } = data;

//     if (!agentId || !deviceUpdates || !Array.isArray(deviceUpdates)) {
//         throw new functions.https.HttpsError('invalid-argument', 'Missing agentId or deviceUpdates array.');
//     }

//     const batch = db.batch();

//     for (const update of deviceUpdates) {
//         const deviceRef = db.collection('devices').doc(update.deviceId);
//         // Only allow updates for devices belonging to this agent
//         // This is also enforced by Firestore rules.
//         batch.update(deviceRef, {
//             lastSeen: admin.firestore.FieldValue.serverTimestamp(),
//             status: update.status || 'online',
//             rtt: update.rtt,
//             offlineChecks: update.offlineChecks || 0,
//             // Increment seenCount if needed, or handle in the agent itself
//         });
//     }

//     // Also update agent's lastSeen
//     const agentRef = db.collection('agents').doc(agentId);
//     batch.update(agentRef, {
//         lastSeen: admin.firestore.FieldValue.serverTimestamp(),
//     });

//     try {
//         await batch.commit();
//         return { status: 'success', message: 'Device heartbeats updated successfully.' };
//     } catch (error) {
//         console.error('Error sending device heartbeat:', error);
//         throw new functions.https.HttpsError('internal', 'Failed to update device heartbeats.', error);
//     }
// });


/**
 * Callable Cloud Function to simulate a device going down for testing/demo purposes.
 * This function should be restricted to admin users or a demo mode.
 */
export const simulateDeviceDown = functions.https.onCall(
    async (data: { deviceId: string }, context: CallableRequest) => {
    // In a real application, you would add authentication and authorization checks here.
    // e.g., if (!context.auth || !context.auth.token.isAdmin) {
    //     throw new functions.https.HttpsError('permission-denied', 'Not authorized to perform this action.');
    // }

    const { deviceId } = data;

    if (!deviceId) {
        throw new functions.https.HttpsError('invalid-argument', 'Device ID is required.');
    }

    const deviceRef = db.collection('devices').doc(deviceId);
    const deviceDoc = await deviceRef.get();

    if (!deviceDoc.exists) {
        throw new functions.https.HttpsError('not-found', 'Device not found.');
    }

    // Force the device status to 'offline' and set lastSeen to an old timestamp
    // to trigger the onDeviceWrite function's offline detection logic.
    // We set it to a time well beyond the offline threshold (e.g., 5 minutes ago).
    const fiveMinutesAgo = admin.firestore.Timestamp.fromMillis(Date.now() - (5 * 60 * 1000) - (60000 * 3)); // 5 mins + 3 * heartbeat

    try {
        await deviceRef.update({
            lastSeen: fiveMinutesAgo,
            status: 'online', // Set to online first so onDeviceWrite can detect the flip
            offlineChecks: 0, // Reset to ensure the logic flows through
        });
        // The onDeviceWrite trigger will now handle marking it offline and generating alerts
        return { status: 'success', message: `Simulation for device ${deviceId} initiated. Check alerts.` };
    } catch (error) {
        console.error('Error simulating device down:', error);
        throw new functions.https.HttpsError('internal', 'Failed to simulate device down.', error);
    }
});
