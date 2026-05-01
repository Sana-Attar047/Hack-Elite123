const mysql = require('mysql2');
const dotenv = require('dotenv');

dotenv.config();

const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'blood_donation_app',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Test connection
pool.getConnection((err, connection) => {
    if (err) {
        if (err.code === 'PROTOCOL_CONNECTION_LOST') {
            console.error('❌ Database connection was closed.');
        }
        if (err.code === 'ER_CON_COUNT_ERROR') {
            console.error('❌ Database has too many connections.');
        }
        if (err.code === 'ECONNREFUSED') {
            console.error('❌ Database connection refused. Make sure XAMPP MySQL is running.');
        }
        console.error('❌ DB Error:', err.message);
    } else {
        console.log('✅ Database connected successfully');
        connection.release();
    }
});

const promisePool = pool.promise();

// Export both promisePool (for queries) and raw pool (for transactions)
module.exports = promisePool;
module.exports.rawPool = pool;
