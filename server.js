const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const http = require('http');
const { Server } = require('socket.io');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const nodemailer = require('nodemailer');
const db = require('./db');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Security middleware
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const JWT_SECRET = process.env.JWT_SECRET || 'secret';
const SEARCH_RADIUS = parseInt(process.env.SEARCH_RADIUS_KM) || 50;

// Rate limiting for auth endpoints
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: { error: 'Too many attempts. Please try again after 15 minutes.' }
});

// Optional email transporter
let emailTransporter = null;
if (process.env.SMTP_USER && process.env.SMTP_PASS) {
    emailTransporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp.gmail.com',
        port: parseInt(process.env.SMTP_PORT) || 587,
        secure: false,
        auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS
        }
    });
    console.log('📧 Email notifications enabled');
} else {
    console.log('📧 Email notifications disabled (no SMTP credentials)');
}

// Validation helpers
const validatePassword = (pwd) => /^(?=.*[a-zA-Z])(?=.*\d).{6,}$/.test(pwd);
const validatePhone = (phone) => /^[6-9]\d{9}$/.test(phone);

// Blood type compatibility map
const bloodCompatibility = {
    'A+':  ['A+', 'A-', 'O+', 'O-'],
    'A-':  ['A-', 'O-'],
    'B+':  ['B+', 'B-', 'O+', 'O-'],
    'B-':  ['B-', 'O-'],
    'AB+': ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'],
    'AB-': ['A-', 'B-', 'AB-', 'O-'],
    'O+':  ['O+', 'O-'],
    'O-':  ['O-']
};

// Haversine SQL fragment
const haversineSQL = `(
    6371 * acos(
        cos(radians(?)) * cos(radians(latitude)) *
        cos(radians(longitude) - radians(?)) +
        sin(radians(?)) * sin(radians(latitude))
    )
)`;

// Authentication Middleware
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Authentication required' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Invalid or expired token' });
        req.user = user;
        next();
    });
};

// Send email helper (non-blocking, fails silently)
async function sendEmail(to, subject, html) {
    if (!emailTransporter) return;
    try {
        await emailTransporter.sendMail({
            from: `"LifeDrop Alerts" <${process.env.SMTP_USER}>`,
            to, subject, html
        });
    } catch (err) {
        console.log('Email send failed (non-critical):', err.message);
    }
}

// Socket.IO connection tracking
const connectedUsers = new Map();

io.on('connection', (socket) => {
    console.log('🔌 Client connected:', socket.id);

    socket.on('register_user', (data) => {
        if (data && data.userId) {
            connectedUsers.set(data.userId, socket.id);
            socket.userId = data.userId;
            console.log(`👤 User ${data.userId} registered to socket ${socket.id}`);
        }
    });

    socket.on('disconnect', () => {
        if (socket.userId) {
            connectedUsers.delete(socket.userId);
        }
    });
});

// ========================
// AUTH ENDPOINTS
// ========================

// Register
app.post('/api/auth/register', authLimiter, async (req, res) => {
    const { name, email, password, phone, blood_group, latitude, longitude, role, city } = req.body;

    if (!name || !email || !password || !phone) {
        return res.status(400).json({ error: 'Name, email, password, and phone are required.' });
    }
    if (!validatePassword(password)) {
        return res.status(400).json({ error: 'Password must be at least 6 characters with at least 1 letter and 1 number.' });
    }
    if (!validatePhone(phone)) {
        return res.status(400).json({ error: 'Invalid Indian phone number. Must be 10 digits starting with 6-9.' });
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const [result] = await db.execute(
            `INSERT INTO users (name, email, password, phone, blood_group, latitude, longitude, role, city) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [name, email, hashedPassword, phone, blood_group || null, latitude || null, longitude || null, role || 'donor', city || null]
        );

        // If blood_bank, initialize inventory for all blood groups
        if (role === 'blood_bank') {
            const bloodGroups = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
            for (const bg of bloodGroups) {
                await db.execute(
                    `INSERT INTO blood_bank_inventory (bank_id, blood_group, units_available) VALUES (?, ?, 0)`,
                    [result.insertId, bg]
                );
            }
        }

        res.status(201).json({ message: 'Account created successfully!', id: result.insertId });
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            res.status(400).json({ error: 'This email is already registered.' });
        } else {
            console.error('Registration error:', error);
            res.status(500).json({ error: 'Server error during registration.' });
        }
    }
});

// Login
app.post('/api/auth/login', authLimiter, async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required.' });
    }

    try {
        const [rows] = await db.execute('SELECT * FROM users WHERE email = ?', [email]);
        if (rows.length === 0) return res.status(404).json({ error: 'No account found with this email.' });

        const user = rows[0];
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) return res.status(401).json({ error: 'Incorrect password.' });

        const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '24h' });
        res.json({
            token,
            role: user.role,
            name: user.name,
            userId: user.id
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Server error during login.' });
    }
});

// ========================
// PROFILE ENDPOINTS
// ========================

// Get Profile
app.get('/api/profile', authenticateToken, async (req, res) => {
    try {
        const [rows] = await db.execute(
            `SELECT id, name, email, phone, blood_group, latitude, longitude, role, 
                    last_donation_date, donation_count, city, created_at 
             FROM users WHERE id = ?`,
            [req.user.id]
        );
        if (rows.length === 0) return res.status(404).json({ error: 'User not found' });
        res.json(rows[0]);
    } catch (error) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Update Location
app.put('/api/profile/location', authenticateToken, async (req, res) => {
    const { latitude, longitude } = req.body;
    try {
        await db.execute('UPDATE users SET latitude = ?, longitude = ? WHERE id = ?',
            [latitude, longitude, req.user.id]);
        res.json({ message: 'Location updated' });
    } catch (error) {
        res.status(500).json({ error: 'Server error' });
    }
});

// ========================
// SEARCH ENDPOINTS
// ========================

// Search nearby donors/blood banks
app.get('/api/search', async (req, res) => {
    const { lat, lng, blood_group, type } = req.query;
    if (!lat || !lng) return res.status(400).json({ error: 'Location required' });

    try {
        let query = '';
        const params = [lat, lng, lat];

        if (type === 'blood_bank') {
            query = `SELECT u.id, u.name, u.phone, u.latitude, u.longitude, u.city,
                            b.units_available, b.blood_group, ${haversineSQL} AS distance 
                     FROM users u 
                     JOIN blood_bank_inventory b ON u.id = b.bank_id 
                     WHERE u.role = 'blood_bank'`;
            if (blood_group) {
                query += ` AND b.blood_group = ? AND b.units_available > 0`;
                params.push(blood_group);
            }
        } else {
            query = `SELECT id, name, phone, blood_group, latitude, longitude, city,
                            ${haversineSQL} AS distance 
                     FROM users 
                     WHERE role = 'donor' 
                       AND latitude IS NOT NULL 
                       AND longitude IS NOT NULL
                       AND (last_donation_date IS NULL OR DATEDIFF(CURDATE(), last_donation_date) > 90)`;
            if (blood_group) {
                query += ` AND blood_group = ?`;
                params.push(blood_group);
            }
        }

        query += ` HAVING distance < ? ORDER BY distance ASC LIMIT 30`;
        params.push(SEARCH_RADIUS);

        const [rows] = await db.execute(query, params);
        res.json(rows);
    } catch (error) {
        console.error('Search error:', error);
        res.status(500).json({ error: 'Server error during search.', details: error.message });
    }
});

// ========================
// EMERGENCY REQUESTS
// ========================

// Create emergency request
app.post('/api/requests', authenticateToken, async (req, res) => {
    const { units_required, blood_group, urgency, latitude, longitude, hospital_name, contact_phone, notes } = req.body;

    if (!units_required || units_required < 1 || units_required > 4) {
        return res.status(400).json({ error: 'Units required must be between 1 and 4.' });
    }
    if (!blood_group) {
        return res.status(400).json({ error: 'Blood group is required.' });
    }

    try {
        const [result] = await db.execute(
            `INSERT INTO emergency_requests (user_id, units_required, blood_group, urgency, latitude, longitude, hospital_name, contact_phone, notes) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [req.user.id, units_required, blood_group, urgency || 'high', latitude || null, longitude || null, hospital_name || null, contact_phone || null, notes || null]
        );

        const requestId = result.insertId;

        // Find compatible donor blood types
        const compatibleTypes = bloodCompatibility[blood_group] || [blood_group];
        const placeholders = compatibleTypes.map(() => '?').join(',');

        // Find eligible donors with compatible blood types
        const [nearbyDonors] = await db.execute(
            `SELECT id, name, email, blood_group FROM users 
             WHERE role = 'donor' 
               AND blood_group IN (${placeholders})
               AND (last_donation_date IS NULL OR DATEDIFF(CURDATE(), last_donation_date) > 90)`,
            [...compatibleTypes]
        );

        // Create notifications for matching donors
        for (const donor of nearbyDonors) {
            await db.execute(
                `INSERT INTO notifications (user_id, title, message, type, request_id) 
                 VALUES (?, ?, ?, 'emergency', ?)`,
                [
                    donor.id,
                    `🚨 Emergency: ${blood_group} blood needed!`,
                    `${units_required} unit(s) of ${blood_group} blood needed urgently. ${hospital_name ? 'Hospital: ' + hospital_name : ''} Urgency: ${(urgency || 'high').toUpperCase()}`,
                    requestId
                ]
            );

            // Real-time notification via Socket.IO
            const socketId = connectedUsers.get(donor.id);
            if (socketId) {
                io.to(socketId).emit('emergency_alert', {
                    id: requestId,
                    blood_group,
                    units_required,
                    urgency: urgency || 'high',
                    hospital_name,
                    latitude,
                    longitude
                });
            }

            // Optional email notification
            if (donor.email) {
                sendEmail(donor.email,
                    `🚨 LifeDrop Emergency: ${blood_group} Blood Needed`,
                    `<h2>Emergency Blood Request</h2>
                     <p><strong>${units_required}</strong> unit(s) of <strong>${blood_group}</strong> blood needed.</p>
                     <p>Urgency: <strong>${(urgency || 'high').toUpperCase()}</strong></p>
                     ${hospital_name ? `<p>Hospital: ${hospital_name}</p>` : ''}
                     <p>Login to LifeDrop to respond: <a href="http://localhost:5000">Open LifeDrop</a></p>`
                );
            }
        }

        // Broadcast to all connected clients for map updates
        io.emit('new_request', {
            id: requestId,
            blood_group,
            units_required,
            urgency: urgency || 'high',
            latitude,
            longitude,
            hospital_name,
            notified_donors: nearbyDonors.length
        });

        res.status(201).json({
            message: 'Emergency request broadcasted!',
            id: requestId,
            donors_notified: nearbyDonors.length
        });
    } catch (error) {
        console.error('Emergency request error:', error);
        res.status(500).json({ error: 'Server error creating request.' });
    }
});

// Get all active requests
app.get('/api/requests', async (req, res) => {
    try {
        const [rows] = await db.execute(`
            SELECT r.*, u.name, u.phone 
            FROM emergency_requests r 
            JOIN users u ON r.user_id = u.id 
            WHERE r.status = 'pending' 
            ORDER BY 
                FIELD(r.urgency, 'critical', 'high', 'normal'),
                r.created_at DESC
        `);
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Get my requests (for patient/hospital)
app.get('/api/requests/mine', authenticateToken, async (req, res) => {
    try {
        const [rows] = await db.execute(`
            SELECT * FROM emergency_requests 
            WHERE user_id = ? 
            ORDER BY created_at DESC
            LIMIT 20
        `, [req.user.id]);
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Cancel a request
app.put('/api/requests/:id/cancel', authenticateToken, async (req, res) => {
    try {
        await db.execute(
            `UPDATE emergency_requests SET status = 'cancelled' WHERE id = ? AND user_id = ?`,
            [req.params.id, req.user.id]
        );
        io.emit('request_updated', { id: parseInt(req.params.id), status: 'cancelled' });
        res.json({ message: 'Request cancelled' });
    } catch (error) {
        res.status(500).json({ error: 'Server error' });
    }
});

// ========================
// DONATIONS
// ========================

// Log a donation
app.post('/api/donations', authenticateToken, async (req, res) => {
    const { request_id, units } = req.body;

    if (req.user.role !== 'donor') {
        return res.status(403).json({ error: 'Only donors can log donations.' });
    }

    const connection = await db.rawPool.promise().getConnection();

    try {
        await connection.beginTransaction();

        // Check eligibility
        const [userRows] = await connection.execute(
            'SELECT last_donation_date FROM users WHERE id = ?', [req.user.id]
        );
        if (userRows.length > 0 && userRows[0].last_donation_date) {
            const lastDate = new Date(userRows[0].last_donation_date);
            const now = new Date();
            const diffDays = Math.ceil(Math.abs(now - lastDate) / (1000 * 60 * 60 * 24));
            if (diffDays <= 90) {
                await connection.rollback();
                connection.release();
                return res.status(400).json({ error: `You must wait ${90 - diffDays} more days before donating again.` });
            }
        }

        // Log donation
        await connection.execute(
            `INSERT INTO donations (donor_id, request_id, units, donation_date) VALUES (?, ?, ?, CURDATE())`,
            [req.user.id, request_id || null, units || 1]
        );

        // Update donor stats
        await connection.execute(
            `UPDATE users SET last_donation_date = CURDATE(), donation_count = donation_count + 1 WHERE id = ?`,
            [req.user.id]
        );

        // If linked to a request, update fulfilled units
        if (request_id) {
            await connection.execute(
                `UPDATE emergency_requests SET units_fulfilled = units_fulfilled + ? WHERE id = ? AND status = 'pending'`,
                [units || 1, request_id]
            );

            // Check if request is now fully fulfilled
            const [reqRows] = await connection.execute(
                'SELECT units_required, units_fulfilled, user_id FROM emergency_requests WHERE id = ?',
                [request_id]
            );
            if (reqRows.length > 0 && reqRows[0].units_fulfilled >= reqRows[0].units_required) {
                await connection.execute(
                    `UPDATE emergency_requests SET status = 'fulfilled' WHERE id = ?`,
                    [request_id]
                );

                // Notify the requester
                await connection.execute(
                    `INSERT INTO notifications (user_id, title, message, type, request_id) 
                     VALUES (?, ?, ?, 'donation', ?)`,
                    [reqRows[0].user_id, '✅ Request Fulfilled!', 
                     'Your blood request has been fully fulfilled! All required units have been pledged.', request_id]
                );

                const reqSocketId = connectedUsers.get(reqRows[0].user_id);
                if (reqSocketId) {
                    io.to(reqSocketId).emit('request_fulfilled', { id: request_id });
                }
                io.emit('request_updated', { id: request_id, status: 'fulfilled' });
            }
        }

        await connection.commit();
        connection.release();

        // Get updated donation count for badge calculation
        const [updatedUser] = await db.execute(
            'SELECT donation_count FROM users WHERE id = ?', [req.user.id]
        );

        res.json({
            message: 'Donation logged successfully! Thank you for saving a life! 🩸',
            donation_count: updatedUser[0]?.donation_count || 1
        });
    } catch (error) {
        await connection.rollback();
        connection.release();
        console.error('Donation error:', error);
        res.status(500).json({ error: 'Server error logging donation.' });
    }
});

// Donation history
app.get('/api/donations/history', authenticateToken, async (req, res) => {
    try {
        const [rows] = await db.execute(`
            SELECT d.*, e.blood_group AS request_blood_group, e.urgency, e.hospital_name
            FROM donations d 
            LEFT JOIN emergency_requests e ON d.request_id = e.id 
            WHERE d.donor_id = ? 
            ORDER BY d.donation_date DESC
            LIMIT 50
        `, [req.user.id]);
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: 'Server error' });
    }
});

// ========================
// BLOOD BANK INVENTORY
// ========================

app.get('/api/inventory', authenticateToken, async (req, res) => {
    if (req.user.role !== 'blood_bank') return res.status(403).json({ error: 'Access denied' });
    try {
        const [rows] = await db.execute(
            'SELECT * FROM blood_bank_inventory WHERE bank_id = ? ORDER BY blood_group',
            [req.user.id]
        );
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/inventory', authenticateToken, async (req, res) => {
    if (req.user.role !== 'blood_bank') return res.status(403).json({ error: 'Access denied' });
    const { blood_group, units } = req.body;

    if (units < 0) return res.status(400).json({ error: 'Units cannot be negative.' });

    try {
        await db.execute(`
            INSERT INTO blood_bank_inventory (bank_id, blood_group, units_available) 
            VALUES (?, ?, ?)
            ON DUPLICATE KEY UPDATE units_available = ?
        `, [req.user.id, blood_group, units, units]);

        // Emit real-time inventory update
        io.emit('inventory_updated', { bank_id: req.user.id, blood_group, units });

        res.json({ message: 'Inventory updated successfully.' });
    } catch (error) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Public blood bank inventory (for patients to view)
app.get('/api/inventory/public', async (req, res) => {
    try {
        const [rows] = await db.execute(`
            SELECT u.id, u.name, u.phone, u.city, u.latitude, u.longitude,
                   b.blood_group, b.units_available
            FROM users u 
            JOIN blood_bank_inventory b ON u.id = b.bank_id 
            WHERE u.role = 'blood_bank' AND b.units_available > 0
            ORDER BY u.name, b.blood_group
        `);
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: 'Server error' });
    }
});

// ========================
// NOTIFICATIONS
// ========================

app.get('/api/notifications', authenticateToken, async (req, res) => {
    try {
        const [rows] = await db.execute(
            `SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 30`,
            [req.user.id]
        );
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/notifications/unread-count', authenticateToken, async (req, res) => {
    try {
        const [rows] = await db.execute(
            'SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND is_read = FALSE',
            [req.user.id]
        );
        res.json({ count: rows[0].count });
    } catch (error) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.put('/api/notifications/read-all', authenticateToken, async (req, res) => {
    try {
        await db.execute(
            'UPDATE notifications SET is_read = TRUE WHERE user_id = ?',
            [req.user.id]
        );
        res.json({ message: 'All notifications marked as read' });
    } catch (error) {
        res.status(500).json({ error: 'Server error' });
    }
});

// ========================
// STATISTICS
// ========================

app.get('/api/stats', async (req, res) => {
    try {
        const [[donors]] = await db.execute("SELECT COUNT(*) as count FROM users WHERE role = 'donor'");
        const [[patients]] = await db.execute("SELECT COUNT(*) as count FROM users WHERE role = 'patient'");
        const [[hospitals]] = await db.execute("SELECT COUNT(*) as count FROM users WHERE role = 'hospital'");
        const [[banks]] = await db.execute("SELECT COUNT(*) as count FROM users WHERE role = 'blood_bank'");
        const [[totalDonations]] = await db.execute("SELECT COUNT(*) as count FROM donations");
        const [[fulfilled]] = await db.execute("SELECT COUNT(*) as count FROM emergency_requests WHERE status = 'fulfilled'");
        const [[pending]] = await db.execute("SELECT COUNT(*) as count FROM emergency_requests WHERE status = 'pending'");

        res.json({
            donors: donors.count,
            patients: patients.count,
            hospitals: hospitals.count,
            blood_banks: banks.count,
            total_donations: totalDonations.count,
            requests_fulfilled: fulfilled.count,
            requests_pending: pending.count
        });
    } catch (error) {
        res.status(500).json({ error: 'Server error' });
    }
});

// ========================
// START SERVER
// ========================

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
    console.log(`\n🩸 LifeDrop Server running on http://localhost:${PORT}`);
    console.log(`🔌 Socket.IO ready for real-time connections`);
    console.log(`📡 Search radius: ${SEARCH_RADIUS}km\n`);
});
