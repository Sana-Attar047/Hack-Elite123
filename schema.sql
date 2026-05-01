-- Run these commands in phpMyAdmin or MySQL CLI

CREATE DATABASE IF NOT EXISTS blood_donation_app;
USE blood_donation_app;

CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    phone VARCHAR(15) NOT NULL,
    blood_group ENUM('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-') NULL, -- Nullable for blood banks/hospitals
    latitude DECIMAL(10, 8),
    longitude DECIMAL(11, 8),
    city VARCHAR(100) DEFAULT NULL,
    role ENUM('donor', 'patient', 'hospital', 'blood_bank') DEFAULT 'donor',
    last_donation_date DATE DEFAULT NULL,
    donation_count INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_blood_group (blood_group),
    INDEX idx_role (role),
    INDEX idx_location (latitude, longitude)
);

CREATE TABLE IF NOT EXISTS emergency_requests (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    units_required INT NOT NULL CHECK(units_required >= 1 AND units_required <= 4),
    units_fulfilled INT DEFAULT 0,
    blood_group ENUM('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-') NOT NULL,
    urgency ENUM('normal', 'high', 'critical') DEFAULT 'high',
    status ENUM('pending', 'fulfilled', 'cancelled') DEFAULT 'pending',
    latitude DECIMAL(10, 8),
    longitude DECIMAL(11, 8),
    hospital_name VARCHAR(200) DEFAULT NULL,
    contact_phone VARCHAR(15) DEFAULT NULL,
    notes TEXT DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_status (status),
    INDEX idx_blood_group_req (blood_group)
);

CREATE TABLE IF NOT EXISTS donations (
    id INT AUTO_INCREMENT PRIMARY KEY,
    donor_id INT NOT NULL,
    request_id INT NULL, 
    units INT NOT NULL DEFAULT 1,
    donation_date DATE NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (donor_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (request_id) REFERENCES emergency_requests(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS blood_bank_inventory (
    id INT AUTO_INCREMENT PRIMARY KEY,
    bank_id INT NOT NULL,
    blood_group ENUM('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-') NOT NULL,
    units_available INT NOT NULL DEFAULT 0,
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (bank_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE KEY unique_inventory (bank_id, blood_group)
);

CREATE TABLE IF NOT EXISTS notifications (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    title VARCHAR(200) NOT NULL,
    message TEXT NOT NULL,
    type ENUM('emergency', 'donation', 'system', 'match') DEFAULT 'emergency',
    is_read BOOLEAN DEFAULT FALSE,
    request_id INT DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (request_id) REFERENCES emergency_requests(id) ON DELETE SET NULL,
    INDEX idx_user_read (user_id, is_read)
);
