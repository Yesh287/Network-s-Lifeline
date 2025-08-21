// Firebase SDK (add to your HTML or include via npm/yarn and bundle)
// For simplicity, we'll assume it's loaded via a script tag in index.html
// <script src="https://www.gstatic.com/firebasejs/9.6.7/firebase-app-compat.js"></script>
// <script src="https://www.gstatic.com/firebasejs/9.6.7/firebase-firestore-compat.js"></script>

// Your Firebase project configuration
// IMPORTANT: Replace with your actual Firebase project configuration
const firebaseConfig = {
    apiKey: "YOUR_API_KEY",
    authDomain: "YOUR_AUTH_DOMAIN",
    projectId: "YOUR_PROJECT_ID",
    storageBucket: "YOUR_STORAGE_BUCKET",
    messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
    appId: "YOUR_APP_ID",
    measurementId: "YOUR_MEASUREMENT_ID" // Optional
};

// Initialize Firebase
firebase.initializeApp(firebaseConfig);

// Get a reference to the Firestore database
const db = firebase.firestore();
const devicesCollection = db.collection('devices');

const devicesContainer = document.getElementById('devices-container');

// Function to render a single device card
function renderDeviceCard(device) {
    const card = document.createElement('div');
    card.className = 'device-card';
    card.setAttribute('data-id', device.id);

    const statusClass = device.status ? device.status.toLowerCase() : 'unknown';
    const lastSeenDate = device.lastSeen ? device.lastSeen.toDate() : null;
    const firstSeenDate = device.firstSeen ? device.firstSeen.toDate() : null;

    card.innerHTML = `
        <h2>${device.hostname || 'N/A'} (${device.ip || 'N/A'})</h2>
        <p><strong>Device ID:</strong> ${device.id}</p>
        <p><strong>Agent ID:</strong> ${device.agentId || 'N/A'}</p>
        <p><strong>OS:</strong> ${device.os || 'N/A'}</p>
        <p><strong>MAC:</strong> ${device.mac || 'N/A'}</p>
        <p><strong>Last Seen:</strong> ${lastSeenDate ? lastSeenDate.toLocaleString() : 'N/A'}</p>
        <p><strong>First Seen:</strong> ${firstSeenDate ? firstSeenDate.toLocaleString() : 'N/A'}</p>
        <p><strong>Status:</strong> <span class="status ${statusClass}">${device.status || 'Unknown'}</span></p>
    `;

    return card;
}

// Listen for real-time updates to the 'devices' collection
devicesCollection.onSnapshot(snapshot => {
    snapshot.docChanges().forEach(change => {
        const deviceData = { id: change.doc.id, ...change.doc.data() };
        const existingCard = devicesContainer.querySelector(`[data-id="${deviceData.id}"]`);

        if (change.type === 'added') {
            // console.log('New device:', deviceData);
            devicesContainer.appendChild(renderDeviceCard(deviceData));
        } else if (change.type === 'modified') {
            // console.log('Modified device:', deviceData);
            if (existingCard) {
                existingCard.replaceWith(renderDeviceCard(deviceData));
            } else {
                // If for some reason the card doesn't exist, add it
                devicesContainer.appendChild(renderDeviceCard(deviceData));
            }
        } else if (change.type === 'removed') {
            // console.log('Removed device:', deviceData);
            if (existingCard) {
                existingCard.remove();
            }
        }
    });
});
