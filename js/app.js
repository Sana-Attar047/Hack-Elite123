// LifeDrop — Shared Frontend Utilities
const API_URL = 'http://localhost:5000/api';

// Socket.IO connection
const socket = io('http://localhost:5000');
let currentUserId = null;

// Register user with Socket.IO after login
function registerSocket(userId) {
    currentUserId = userId;
    socket.emit('register_user', { userId });
}

// Toast container
(function initToastContainer() {
    if (!document.querySelector('.toast-container')) {
        const tc = document.createElement('div');
        tc.className = 'toast-container';
        document.body.appendChild(tc);
    }
})();

// Show toast notification
function showToast(message, type = 'info') {
    const container = document.querySelector('.toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 5000);
}

// Alert box (legacy support)
function showAlert(message, type = 'error') {
    const alertBox = document.getElementById('alertMsg');
    if (!alertBox) return showToast(message, type === 'error' ? 'emergency' : 'success');
    alertBox.textContent = message;
    alertBox.className = `alert ${type}`;
    alertBox.style.display = 'block';
    setTimeout(() => { alertBox.style.display = 'none'; }, 5000);
}

// Auth helpers
function getToken() { return localStorage.getItem('token'); }
function getUserId() { return localStorage.getItem('userId'); }

function logout() {
    localStorage.clear();
    window.location.href = 'index.html';
}

function checkAuth() {
    if (!getToken()) window.location.href = 'index.html';
    const uid = getUserId();
    if (uid) registerSocket(parseInt(uid));
}

// Geolocation
function getUserLocation() {
    return new Promise((resolve, reject) => {
        if (!navigator.geolocation) return reject(new Error('Geolocation not supported'));
        navigator.geolocation.getCurrentPosition(
            pos => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
            err => reject(err),
            { enableHighAccuracy: true, timeout: 10000 }
        );
    });
}

// Time ago helper
function timeAgo(dateStr) {
    const now = new Date();
    const date = new Date(dateStr);
    const diff = Math.floor((now - date) / 1000);
    if (diff < 60) return 'Just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
}

// Badge calculator
function getBadges(count) {
    return [
        { name: 'First Drop', icon: '🩸', req: 1, earned: count >= 1 },
        { name: 'Regular', icon: '⭐', req: 5, earned: count >= 5 },
        { name: 'Life Saver', icon: '🏅', req: 10, earned: count >= 10 },
        { name: 'Legend', icon: '🏆', req: 25, earned: count >= 25 },
        { name: 'Champion', icon: '👑', req: 50, earned: count >= 50 }
    ];
}

// SOS Audio beep (Web Audio API)
function playSOSBeep() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        [0, 0.2, 0.4].forEach(delay => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.frequency.value = 880;
            osc.type = 'sine';
            gain.gain.value = 0.3;
            osc.start(ctx.currentTime + delay);
            osc.stop(ctx.currentTime + delay + 0.15);
        });
    } catch (e) { /* silent fail */ }
}

// Blood compatibility map
const BLOOD_COMPAT = {
    'A+': ['A+','A-','O+','O-'], 'A-': ['A-','O-'],
    'B+': ['B+','B-','O+','O-'], 'B-': ['B-','O-'],
    'AB+': ['A+','A-','B+','B-','AB+','AB-','O+','O-'], 'AB-': ['A-','B-','AB-','O-'],
    'O+': ['O+','O-'], 'O-': ['O-']
};

// Notification system
async function loadNotifications(container, bellBadge) {
    try {
        const res = await fetch(`${API_URL}/notifications`, {
            headers: { 'Authorization': `Bearer ${getToken()}` }
        });
        const data = await res.json();
        if (bellBadge) {
            const unread = data.filter(n => !n.is_read).length;
            bellBadge.textContent = unread;
            bellBadge.style.display = unread > 0 ? 'flex' : 'none';
        }
        if (container) {
            container.innerHTML = data.length === 0
                ? '<p style="padding:1rem;color:var(--text-muted);text-align:center;font-size:0.85rem;">No notifications</p>'
                : data.map(n => `
                    <div class="notif-item ${n.is_read ? '' : 'unread'}">
                        <div class="notif-title">${n.title}</div>
                        <div class="notif-msg">${n.message}</div>
                        <div class="notif-time">${timeAgo(n.created_at)}</div>
                    </div>
                `).join('');
        }
    } catch (e) { /* silent */ }
}

async function markAllRead() {
    try {
        await fetch(`${API_URL}/notifications/read-all`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${getToken()}` }
        });
    } catch (e) { /* silent */ }
}

// Socket.IO global listeners
socket.on('emergency_alert', (data) => {
    playSOSBeep();
    showToast(`🚨 EMERGENCY: ${data.blood_group} blood needed! ${data.units_required} unit(s)`, 'emergency');
});

socket.on('request_fulfilled', (data) => {
    showToast('✅ A blood request has been fulfilled!', 'success');
});
