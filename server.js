const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const PORT = Number(process.env.PORT || 3000);

const dbConfig = {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'survey_record_management'
};

const pool = mysql.createPool({
    ...dbConfig,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
    const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
    return { salt, hash };
}

function verifyPassword(password, user) {
    const { hash } = hashPassword(password, user.password_salt);
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.password_hash, 'hex'));
}

function toApiUser(user) {
    return {
        id: user.id,
        name: user.full_name,
        username: user.username,
        email: user.email,
        role: user.role,
        status: user.status,
        createdAt: user.created_at,
        approvedAt: user.approved_at
    };
}

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(__dirname));

function normalizeSurvey(row) {
    if (!row) return null;

    try {
        return typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
    } catch (error) {
        return {
            id: row.id,
            surveyNumber: row.survey_number,
            surveyName: row.survey_name,
            surveyor: row.surveyor
        };
    }
}

async function ensureDatabase() {
    const bootstrap = await mysql.createConnection({
        host: dbConfig.host,
        port: dbConfig.port,
        user: dbConfig.user,
        password: dbConfig.password
    });

    await bootstrap.query(`CREATE DATABASE IF NOT EXISTS \`${dbConfig.database}\``);
    await bootstrap.end();

    await pool.query(`
        CREATE TABLE IF NOT EXISTS surveys (
            id BIGINT PRIMARY KEY,
            survey_number VARCHAR(100) NOT NULL UNIQUE,
            survey_name VARCHAR(255) NOT NULL,
            surveyor VARCHAR(150) NOT NULL,
            local_gov VARCHAR(150),
            job_type VARCHAR(100),
            survey_date DATE,
            easting DOUBLE,
            northing DOUBLE,
            payload JSON NOT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_survey_number (survey_number),
            INDEX idx_survey_name (survey_name),
            INDEX idx_surveyor (surveyor),
            INDEX idx_survey_date (survey_date)
        )
    `);

    await pool.query('ALTER TABLE surveys MODIFY easting DOUBLE');
    await pool.query('ALTER TABLE surveys MODIFY northing DOUBLE');

    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id INT AUTO_INCREMENT PRIMARY KEY,
            full_name VARCHAR(150) NOT NULL,
            username VARCHAR(100) NOT NULL UNIQUE,
            email VARCHAR(160) NOT NULL UNIQUE,
            password_hash VARCHAR(255) NOT NULL,
            password_salt VARCHAR(64) NOT NULL,
            role ENUM('admin', 'user') NOT NULL DEFAULT 'user',
            status ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
            approved_by INT NULL,
            approved_at TIMESTAMP NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS audit_logs (
            id BIGINT AUTO_INCREMENT PRIMARY KEY,
            action VARCHAR(80) NOT NULL,
            entity_type VARCHAR(80) NOT NULL,
            entity_id VARCHAR(120),
            actor_id INT NULL,
            actor_name VARCHAR(150),
            actor_role VARCHAR(50),
            details JSON,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_audit_action (action),
            INDEX idx_audit_actor_id (actor_id),
            INDEX idx_audit_created_at (created_at)
        )
    `);

    const [admins] = await pool.query("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
    if (!admins.length) {
        const password = hashPassword('mercy123');
        await pool.execute(
            `INSERT INTO users
                (full_name, username, email, password_hash, password_salt, role, status, approved_at)
             VALUES (?, ?, ?, ?, ?, 'admin', 'approved', CURRENT_TIMESTAMP)`,
            ['HISMERCY', 'His Mercy', 'admin@survey.local', password.hash, password.salt]
        );
    }
}

app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'survey-record-management-backend' });
});

app.post('/api/auth/register', async (req, res, next) => {
    try {
        const fullName = String(req.body.fullName || '').trim();
        const username = String(req.body.username || '').trim();
        const email = String(req.body.email || '').trim().toLowerCase();
        const passwordText = String(req.body.password || '');

        if (!fullName || !username || !email || passwordText.length < 6) {
            return res.status(400).json({ message: 'Full name, username, email, and a 6 character password are required' });
        }

        const password = hashPassword(passwordText);
        await pool.execute(
            `INSERT INTO users (full_name, username, email, password_hash, password_salt)
             VALUES (?, ?, ?, ?, ?)`,
            [fullName, username, email, password.hash, password.salt]
        );

        res.status(201).json({ message: 'Registration submitted. Wait for administrator approval.' });
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ message: 'Username or email already exists' });
        }
        next(error);
    }
});

app.post('/api/auth/login', async (req, res, next) => {
    try {
        const username = String(req.body.username || '').trim();
        const password = String(req.body.password || '');

        const [users] = await pool.execute('SELECT * FROM users WHERE username = ?', [username]);
        if (!users.length || !verifyPassword(password, users[0])) {
            return res.status(401).json({ message: 'Invalid username or password' });
        }

        if (users[0].status !== 'approved') {
            return res.status(403).json({ message: `Your account is ${users[0].status}. Contact the administrator.` });
        }

        res.json({ user: toApiUser(users[0]) });
    } catch (error) {
        next(error);
    }
});

app.put('/api/auth/change-password', async (req, res, next) => {
    try {
        const userId = req.body.userId;
        const currentPassword = String(req.body.currentPassword || '');
        const newPassword = String(req.body.newPassword || '');

        if (!userId || !currentPassword || newPassword.length < 6) {
            return res.status(400).json({ message: 'Current password and a new 6 character password are required' });
        }

        const [users] = await pool.execute('SELECT * FROM users WHERE id = ?', [userId]);
        if (!users.length || !verifyPassword(currentPassword, users[0])) {
            return res.status(401).json({ message: 'Current password is incorrect' });
        }

        const password = hashPassword(newPassword);
        await pool.execute(
            'UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?',
            [password.hash, password.salt, userId]
        );

        await pool.execute(
            `INSERT INTO audit_logs
                (action, entity_type, entity_id, actor_id, actor_name, actor_role, details)
             VALUES ('password_changed', 'user', ?, ?, ?, ?, CAST(? AS JSON))`,
            [
                userId,
                userId,
                users[0].full_name,
                users[0].role,
                JSON.stringify({ mode: 'self_service' })
            ]
        );

        res.json({ message: 'Password changed successfully' });
    } catch (error) {
        next(error);
    }
});

app.get('/api/users', async (req, res, next) => {
    try {
        const [users] = await pool.query(
            `SELECT id, full_name, username, email, role, status, created_at, approved_at
             FROM users ORDER BY status = 'pending' DESC, created_at DESC`
        );
        res.json({ users: users.map(toApiUser) });
    } catch (error) {
        next(error);
    }
});

app.get('/api/audit-logs', async (req, res, next) => {
    try {
        const [logs] = await pool.query(
            `SELECT id, action, entity_type, entity_id, actor_id, actor_name, actor_role, details, created_at
             FROM audit_logs ORDER BY created_at DESC LIMIT 100`
        );
        res.json({ logs });
    } catch (error) {
        next(error);
    }
});

app.post('/api/audit-logs', async (req, res, next) => {
    try {
        await pool.execute(
            `INSERT INTO audit_logs
                (action, entity_type, entity_id, actor_id, actor_name, actor_role, details)
             VALUES (?, ?, ?, ?, ?, ?, CAST(? AS JSON))`,
            [
                req.body.action || 'unknown',
                req.body.entityType || 'unknown',
                req.body.entityId || null,
                req.body.actorId || null,
                req.body.actorName || null,
                req.body.actorRole || null,
                JSON.stringify(req.body.details || {})
            ]
        );
        res.status(201).json({ message: 'Audit log saved' });
    } catch (error) {
        next(error);
    }
});

app.put('/api/users/:id/status', async (req, res, next) => {
    try {
        const status = String(req.body.status || '').trim();
        const adminId = req.body.adminId || null;

        if (!['approved', 'rejected'].includes(status)) {
            return res.status(400).json({ message: 'Status must be approved or rejected' });
        }

        const [result] = await pool.execute(
            `UPDATE users
             SET status = ?, approved_by = ?, approved_at = IF(? = 'approved', CURRENT_TIMESTAMP, approved_at)
             WHERE id = ? AND role <> 'admin'`,
            [status, adminId, status, req.params.id]
        );

        if (!result.affectedRows) {
            return res.status(404).json({ message: 'User not found or cannot update administrator' });
        }

        await pool.execute(
            `INSERT INTO audit_logs
                (action, entity_type, entity_id, actor_id, actor_name, actor_role, details)
             VALUES (?, 'user', ?, ?, ?, 'admin', CAST(? AS JSON))`,
            [
                `user_${status}`,
                req.params.id,
                adminId,
                req.body.adminName || null,
                JSON.stringify({ status })
            ]
        );

        res.json({ message: `User ${status}` });
    } catch (error) {
        next(error);
    }
});

app.put('/api/users/:id/password', async (req, res, next) => {
    try {
        const adminId = req.body.adminId || null;
        const adminName = req.body.adminName || null;
        const newPassword = String(req.body.newPassword || '');

        if (newPassword.length < 6) {
            return res.status(400).json({ message: 'New password must be at least 6 characters' });
        }

        const [admins] = await pool.execute(
            "SELECT id FROM users WHERE id = ? AND role = 'admin' AND status = 'approved'",
            [adminId]
        );
        if (!admins.length) {
            return res.status(403).json({ message: 'Only an approved administrator can reset passwords' });
        }

        const password = hashPassword(newPassword);
        const [result] = await pool.execute(
            'UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?',
            [password.hash, password.salt, req.params.id]
        );

        if (!result.affectedRows) {
            return res.status(404).json({ message: 'User not found' });
        }

        await pool.execute(
            `INSERT INTO audit_logs
                (action, entity_type, entity_id, actor_id, actor_name, actor_role, details)
             VALUES ('password_reset', 'user', ?, ?, ?, 'admin', CAST(? AS JSON))`,
            [
                req.params.id,
                adminId,
                adminName,
                JSON.stringify({ mode: 'admin_reset' })
            ]
        );

        res.json({ message: 'Password reset successfully' });
    } catch (error) {
        next(error);
    }
});

app.get('/api/surveys', async (req, res, next) => {
    try {
        const [rows] = await pool.query('SELECT payload FROM surveys ORDER BY created_at DESC, id DESC');
        res.json({ surveys: rows.map(normalizeSurvey) });
    } catch (error) {
        next(error);
    }
});

app.get('/api/surveys/:id', async (req, res, next) => {
    try {
        const [rows] = await pool.execute('SELECT payload FROM surveys WHERE id = ?', [req.params.id]);

        if (!rows.length) {
            return res.status(404).json({ message: 'Survey record not found' });
        }

        res.json({ survey: normalizeSurvey(rows[0]) });
    } catch (error) {
        next(error);
    }
});

app.put('/api/surveys/bulk', async (req, res, next) => {
    const surveys = Array.isArray(req.body.surveys) ? req.body.surveys : null;

    if (!surveys) {
        return res.status(400).json({ message: 'surveys must be an array' });
    }

    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();
        await connection.query('DELETE FROM surveys');

        for (const survey of surveys) {
            if (!survey.id || !survey.surveyNumber || !survey.surveyName || !survey.surveyor) {
                throw Object.assign(new Error('Each survey needs id, surveyNumber, surveyName, and surveyor'), {
                    statusCode: 400
                });
            }

            await connection.execute(
                `INSERT INTO surveys
                    (id, survey_number, survey_name, surveyor, local_gov, job_type, survey_date, easting, northing, payload)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON))`,
                [
                    survey.id,
                    survey.surveyNumber,
                    survey.surveyName,
                    survey.surveyor,
                    survey.localGov || null,
                    survey.jobType || null,
                    survey.surveyDate || null,
                    survey.easting ?? null,
                    survey.northing ?? null,
                    JSON.stringify(survey)
                ]
            );
        }

        await connection.commit();
        res.json({ message: 'Survey records synced', count: surveys.length });
    } catch (error) {
        await connection.rollback();
        next(error);
    } finally {
        connection.release();
    }
});

app.post('/api/surveys', async (req, res, next) => {
    try {
        const survey = req.body;

        if (!survey.id || !survey.surveyNumber || !survey.surveyName || !survey.surveyor) {
            return res.status(400).json({ message: 'id, surveyNumber, surveyName, and surveyor are required' });
        }

        await pool.execute(
            `INSERT INTO surveys
                (id, survey_number, survey_name, surveyor, local_gov, job_type, survey_date, easting, northing, payload)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON))
             ON DUPLICATE KEY UPDATE
                survey_number = VALUES(survey_number),
                survey_name = VALUES(survey_name),
                surveyor = VALUES(surveyor),
                local_gov = VALUES(local_gov),
                job_type = VALUES(job_type),
                survey_date = VALUES(survey_date),
                easting = VALUES(easting),
                northing = VALUES(northing),
                payload = VALUES(payload)`,
            [
                survey.id,
                survey.surveyNumber,
                survey.surveyName,
                survey.surveyor,
                survey.localGov || null,
                survey.jobType || null,
                survey.surveyDate || null,
                survey.easting ?? null,
                survey.northing ?? null,
                JSON.stringify(survey)
            ]
        );

        res.status(201).json({ survey });
    } catch (error) {
        next(error);
    }
});

app.delete('/api/surveys/:id', async (req, res, next) => {
    try {
        const [result] = await pool.execute('DELETE FROM surveys WHERE id = ?', [req.params.id]);

        if (!result.affectedRows) {
            return res.status(404).json({ message: 'Survey record not found' });
        }

        res.status(204).send();
    } catch (error) {
        next(error);
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

app.use((req, res) => {
    res.status(404).json({ message: 'Route not found' });
});

app.use((error, req, res, next) => {
    console.error(error);
    res.status(error.statusCode || 500).json({
        message: error.statusCode ? error.message : 'Server error'
    });
});

ensureDatabase()
    .then(() => {
        app.listen(PORT, () => {
            console.log(`Server is live at http://localhost:${PORT}`);
        });
    })
    .catch((error) => {
        console.error('Unable to start server. Check your MySQL settings.');
        console.error(error.message);
        process.exit(1);
    });
